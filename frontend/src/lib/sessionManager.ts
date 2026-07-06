/**
 * Streaming Session Manager
 * =========================
 * Bridges the native RootShell event emitter with:
 *   1. A local in-memory ring buffer (for fast UI rendering)
 *   2. The backend /api/sessions/* endpoints (so MCP / remote dashboards
 *      can poll live output, and Mongo gets a final summary on session end).
 *
 * Designed for the user's 3x AWUS036NH pentest rig — multiple sessions
 * (e.g. airodump on wlan2, tcpdump on wlan3, wifite on wlan4) can run
 * simultaneously.
 */
import { startStream, killStream, hasNativeStreaming, writeStdin, resizeSession } from "./rootShell";

export type LineRecord = {
  stream: "stdout" | "stderr";
  line: string;
  line_no: number;
  ts: number;
};

export type SessionState = {
  id: string;
  command: string;
  iface: string;
  label: string;
  startedAt: number;
  endedAt?: number;
  pid?: number;
  exitCode?: number;
  status: "starting" | "running" | "ended" | "killed" | "error";
  /** Which tab owns this session — enforces full isolation between the
   *  Kali terminal / Live view / AI agent so their streams never mix. */
  owner?: "kali" | "live" | "ai";
  lines: LineRecord[];        // ring buffer (derived from raw chunks — for Live/flat views + backend)
  lineCount: number;          // total lines ever (including dropped from ring)
  errorMessage?: string;
  mocked: boolean;
  /** Raw PTY byte chunks (base64, native order) kept for xterm re-mount
   *  replay. Bounded by RAW_LOG_MAX_BYTES; oldest chunks drop first. Not
   *  used by the flat/Live views — those read `lines`. */
  rawLog?: { stream: "stdout" | "stderr"; b64: string; bytes: number }[];
  rawLogBytes?: number;
  /** Partial (un-terminated) line carried across chunks while deriving
   *  `lines` from the raw byte stream. Latin1/binary string. */
  partial?: string;
  /** Last PTY size we told native, so resize() can dedupe. */
  ptyCols?: number;
  ptyRows?: number;
};

/** Callback for raw base64 chunk delivery — the xterm.js render path. */
type RawListener = (b64: string, stream: "stdout" | "stderr") => void;

type Listener = () => void;

// Base64 → binary (Latin1) string. RN Hermes exposes a global atob; fall
// back to a tiny decoder so line-derivation works everywhere. We keep the
// result as a byte-preserving binary string (each char code = one byte) so
// splitting on '\n' (0x0a) and trimming '\r' (0x0d) is exact.
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64ToBinary(b64: string): string {
  const g: any = globalThis as any;
  if (typeof g.atob === "function") {
    try { return g.atob(b64); } catch { /* fall through */ }
  }
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < b64.length; i++) {
    const c = b64.charCodeAt(i);
    if (c === 61) break; // '='
    const v = B64_CHARS.indexOf(b64[i]);
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}

const RING_MAX = 1500;          // lines kept in memory per session
const RAW_LOG_MAX_BYTES = 262144; // 256 KiB of raw scrollback kept for xterm re-mount replay
const FLUSH_INTERVAL_MS = 1500;  // how often we POST a batch to backend
const FLUSH_BATCH_MAX = 200;     // max lines in one POST
// Coalesce UI notifications to ~30Hz max. Without this, a dmesg-style burst
// (even when native-batched) still triggers a re-render per arriving batch
// (~12Hz × multiple streams), which is fine, but if multiple sessions are
// running concurrently the React renders can stack. rAF coalescing folds any
// number of state changes within one frame into a single re-render.
const NOTIFY_THROTTLE_MS = 33;

class SessionManager {
  sessions = new Map<string, SessionState>();
  private pendingFlush = new Map<string, LineRecord[]>();
  private unsubscribers = new Map<string, () => void>();
  private listeners = new Set<Listener>();
  private rawListeners = new Map<string, Set<RawListener>>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private apiBase: string = "";
  // Notify-throttle state — coalesce multiple line batches arriving inside
  // one frame budget into a single subscriber notification.
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private notifyPending: boolean = false;

  configure(apiBase: string) {
    this.apiBase = apiBase.replace(/\/$/, "");
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flushAll().catch(() => {}), FLUSH_INTERVAL_MS);
    }
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  private notify() {
    // Throttle: at most one fan-out per NOTIFY_THROTTLE_MS, with a trailing
    // notification scheduled if any further requests arrived during the
    // throttle window. This keeps the UI responsive without burning the JS
    // thread when 30k lines/sec are streaming in.
    if (this.notifyTimer) {
      this.notifyPending = true;
      return;
    }
    this.fanOut();
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      if (this.notifyPending) {
        this.notifyPending = false;
        this.notify();
      }
    }, NOTIFY_THROTTLE_MS);
  }

  private fanOut() {
    this.listeners.forEach((l) => { try { l(); } catch {} });
  }

  list(): SessionState[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): SessionState | undefined {
    return this.sessions.get(id);
  }

  /**
   * Start a streaming session. Returns the session id (caller-provided or generated).
   * - Registers backend session for MCP visibility
   * - Subscribes to native events and buffers lines
   * - Falls back to a "mock" mode if native streaming isn't available (preview)
   */
  async start(opts: { command: string; iface?: string; label?: string; id?: string; owner?: "kali" | "live" | "ai"; forceMock?: boolean }): Promise<string> {
    const id = opts.id || `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const state: SessionState = {
      id,
      command: opts.command,
      iface: opts.iface || "",
      label: opts.label || (opts.command.split(/\s+/)[0] || "session"),
      startedAt: Date.now(),
      status: "starting",
      owner: opts.owner,
      lines: [],
      lineCount: 0,
      mocked: false,  // determined below via lazy probe
      rawLog: [],
      rawLogBytes: 0,
      partial: "",
    };
    this.sessions.set(id, state);
    this.pendingFlush.set(id, []);
    this.notify();

    // Lazy check — at *call time*, not module-import time. The RN bridge sometimes
    // hasn't built its method table yet when rootShell.ts is first evaluated.
    // forceMock=true also routes us into the mock branch (when user globally
    // chose MOCK exec mode in settings).
    const streamingAvailable = !opts.forceMock && hasNativeStreaming();
    state.mocked = !streamingAvailable;

    // Register with backend (best-effort)
    if (this.apiBase) {
      try {
        await fetch(`${this.apiBase}/sessions/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id, command: opts.command, iface: opts.iface || "",
            label: opts.label || "", mocked: state.mocked,
          }),
        });
      } catch (e) { /* best-effort */ }
    }

    if (!streamingAvailable) {
      // Preview / Expo Go fallback — synthesize a few mocked lines and end.
      state.status = "running";
      this.notify();
      const fakeLines = [
        `[mock] would exec: ${opts.command}`,
        `[mock] iface=${opts.iface || "?"} — native streaming unavailable in preview`,
        `[mock] build the APK to see real output`,
      ];
      fakeLines.forEach((l, i) => this.handleLine(id, { stream: "stdout", line: l, line_no: i + 1 }));
      setTimeout(() => this.handleExit(id, 0, 0), 200);
      return id;
    }

    const unsub = startStream(id, opts.command, {
      onPid: (e) => {
        const s = this.sessions.get(id); if (!s) return;
        s.pid = e.pid; s.status = "running";
        this.notify();
      },
      // Preferred path — native relays the raw PTY byte stream as base64
      // chunks. We fan them straight to xterm subscribers (which decode +
      // term.write() the exact bytes so \r redraws / colors / TUIs work)
      // AND derive clean lines for the flat Live view + backend.
      onChunk: (e) => this.handleChunk(id, e.stream, e.dataB64),
      // Legacy line paths — only old APKs still emit these; kept wired so a
      // build mismatch degrades gracefully instead of showing nothing.
      onLines: (e) => this.handleLinesBatch(id, e.stream, e.lines, e.toLineNo),
      onLine: (e) => this.handleLine(id, { stream: e.stream, line: e.line, line_no: e.lineNo }),
      onExit: (e) => this.handleExit(id, e.exit_code, e.duration_ms),
      onError: (e) => {
        const s = this.sessions.get(id); if (!s) return;
        s.status = "error"; s.errorMessage = e.message; s.endedAt = Date.now();
        this.notify();
        this.endBackend(id, -1, Date.now() - s.startedAt, "error").catch(() => {});
      },
    });
    this.unsubscribers.set(id, unsub);
    return id;
  }

  private handleLine(id: string, l: { stream: "stdout" | "stderr"; line: string; line_no: number }) {
    const s = this.sessions.get(id); if (!s) return;
    if (s.status === "starting") s.status = "running";
    const rec: LineRecord = { stream: l.stream, line: l.line, line_no: l.line_no, ts: Date.now() };
    s.lines.push(rec);
    if (s.lines.length > RING_MAX) s.lines.splice(0, s.lines.length - RING_MAX);
    s.lineCount = Math.max(s.lineCount, l.line_no);
    const pf = this.pendingFlush.get(id); if (pf) pf.push(rec);
    this.notify();
  }

  /**
   * Apply a batch of lines from native in O(batch) work — one push, one
   * bounded splice if we overflow the ring, one notify. This is the hot
   * path under heavy streaming load (dmesg, wifite, airodump after some
   * minutes of capture).
   */
  private handleLinesBatch(id: string, stream: "stdout" | "stderr", lines: string[], toLineNo: number) {
    const s = this.sessions.get(id); if (!s) return;
    if (lines.length === 0) return;
    if (s.status === "starting") s.status = "running";
    const now = Date.now();
    // Reconstruct per-line numbers: the batch ends at toLineNo, so the
    // first line in the batch is (toLineNo - count + 1). This may slightly
    // over/under-count if stdout and stderr interleave (they share the
    // same counter), but it's a UI label only — ordering remains correct.
    const startLineNo = toLineNo - lines.length + 1;
    const records: LineRecord[] = new Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      records[i] = { stream, line: lines[i], line_no: startLineNo + i, ts: now };
    }
    // Single push (Array.prototype.push is variadic — one call adds all).
    s.lines.push(...records);
    if (s.lines.length > RING_MAX) s.lines.splice(0, s.lines.length - RING_MAX);
    s.lineCount = Math.max(s.lineCount, toLineNo);
    // Backend flush queue
    const pf = this.pendingFlush.get(id);
    if (pf) pf.push(...records);
    this.notify();
  }

  // ── Raw chunk path (xterm PTY relay) ──────────────────────────────────
  /**
   * A raw base64 byte chunk arrived from native. Two things happen:
   *   1. Fan it out verbatim to any xterm subscribers (they decode + write
   *      the exact bytes so \r redraws / ANSI colors / TUIs render right),
   *      and append it to the bounded raw log for re-mount replay.
   *   2. Derive clean text lines (split on \n, drop \r) for the flat Live
   *      view + backend session store, keeping those consumers working.
   */
  private handleChunk(id: string, stream: "stdout" | "stderr", b64: string) {
    const s = this.sessions.get(id);
    if (!s || !b64) return;
    if (s.status === "starting") s.status = "running";

    // 1) raw log (bounded) + fan-out to xterm
    const bin = b64ToBinary(b64);
    if (!s.rawLog) { s.rawLog = []; s.rawLogBytes = 0; }
    s.rawLog.push({ stream, b64, bytes: bin.length });
    s.rawLogBytes = (s.rawLogBytes || 0) + bin.length;
    while ((s.rawLogBytes || 0) > RAW_LOG_MAX_BYTES && s.rawLog.length > 1) {
      const dropped = s.rawLog.shift();
      s.rawLogBytes = (s.rawLogBytes || 0) - (dropped?.bytes || 0);
    }
    const rl = this.rawListeners.get(id);
    if (rl) rl.forEach((cb) => { try { cb(b64, stream); } catch {} });

    // 2) derive lines for flat/Live/backend
    s.partial = (s.partial || "") + bin;
    let nl: number;
    // eslint-disable-next-line no-cond-assign
    while ((nl = s.partial.indexOf("\n")) >= 0) {
      let line = s.partial.slice(0, nl);
      s.partial = s.partial.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const rec: LineRecord = { stream, line, line_no: s.lineCount + 1, ts: Date.now() };
      s.lines.push(rec);
      s.lineCount += 1;
      const pf = this.pendingFlush.get(id); if (pf) pf.push(rec);
    }
    if (s.lines.length > RING_MAX) s.lines.splice(0, s.lines.length - RING_MAX);
    this.notify();
  }

  /** Subscribe to raw base64 chunks for a session (xterm render path). */
  subscribeRaw(id: string, cb: RawListener): () => void {
    let set = this.rawListeners.get(id);
    if (!set) { set = new Set(); this.rawListeners.set(id, set); }
    set.add(cb);
    return () => {
      const s = this.rawListeners.get(id);
      if (s) { s.delete(cb); if (s.size === 0) this.rawListeners.delete(id); }
    };
  }

  /** The raw base64 chunk log for a session (for xterm re-mount replay). */
  getRawLog(id: string): { stream: "stdout" | "stderr"; b64: string }[] {
    return this.sessions.get(id)?.rawLog || [];
  }

  /** Resize a session's PTY (debounced/deduped) to xterm's dimensions. */
  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s || (s.status !== "running" && s.status !== "starting")) return;
    if (cols < 2 || rows < 2) return;
    if (s.ptyCols === cols && s.ptyRows === rows) return;
    s.ptyCols = cols; s.ptyRows = rows;
    resizeSession(id, cols, rows).catch(() => {});
  }

  private handleExit(id: string, exitCode: number, durationMs: number) {
    const s = this.sessions.get(id); if (!s) return;
    s.status = "ended";
    s.exitCode = exitCode;
    s.endedAt = Date.now();
    this.notify();
    // Flush remaining + signal backend end
    this.flushSession(id)
      .then(() => this.endBackend(id, exitCode, durationMs, "ended"))
      .catch(() => {});
    const u = this.unsubscribers.get(id); if (u) { u(); this.unsubscribers.delete(id); }
  }

  async kill(id: string, graceful: boolean): Promise<void> {
    const s = this.sessions.get(id); if (!s) return;
    if (s.status === "ended" || s.status === "killed" || s.status === "error") return;
    await killStream(id, graceful);
    // The native side will fire onExit; if it doesn't (rare), mark killed after 5s
    setTimeout(() => {
      const cur = this.sessions.get(id);
      if (cur && cur.status === "running") {
        cur.status = "killed";
        cur.endedAt = Date.now();
        this.notify();
        this.flushSession(id).then(() => this.endBackend(id, -2, Date.now() - cur.startedAt, "killed")).catch(() => {});
      }
    }, 5000);
  }

  /**
   * Send a line of text to a running session's stdin. Used by the AI tab to
   * feed user chat input into hermes / CAI / etc. Echoes the sent text into
   * the session's own line buffer (as a "stdout" record prefixed with "▸ ")
   * so the conversation reads top-to-bottom as a transcript. Returns the
   * number of bytes the native side wrote, or 0 on failure / non-native.
   *
   * When `echo` is false we skip the local "▸ " transcript line — used by
   * the xterm.js view mode where the shell itself echoes input back via
   * stdout, and a duplicated local echo would print every keystroke twice.
   */
  async sendInput(id: string, text: string, appendNewline: boolean = true, echo: boolean = true): Promise<number> {
    const s = this.sessions.get(id);
    if (!s) return 0;
    if (s.status !== "running" && s.status !== "starting") return 0;
    const written = await writeStdin(id, text, appendNewline);
    if (!echo) return written;
    // Echo locally so the UI shows what the user typed, even if the agent
    // doesn't echo it back itself. The leading "▸ " marker lets the
    // renderer style user-input differently from agent output.
    const echoLine = `▸ ${text}`;
    const rec: LineRecord = {
      stream: "stdout",
      line: echoLine,
      line_no: s.lineCount + 1,
      ts: Date.now(),
    };
    s.lines.push(rec);
    if (s.lines.length > RING_MAX) s.lines.splice(0, s.lines.length - RING_MAX);
    s.lineCount += 1;
    const pf = this.pendingFlush.get(id); if (pf) pf.push(rec);
    this.notify();
    return written;
  }

  /** Remove a session from local + backend memory (Mongo summary preserved). */
  async remove(id: string): Promise<void> {
    this.sessions.delete(id);
    this.pendingFlush.delete(id);
    this.rawListeners.delete(id);
    const u = this.unsubscribers.get(id); if (u) { u(); this.unsubscribers.delete(id); }
    this.notify();
    if (this.apiBase) {
      try { await fetch(`${this.apiBase}/sessions/${id}`, { method: "DELETE" }); } catch {}
    }
  }

  private async flushAll(): Promise<void> {
    for (const id of this.pendingFlush.keys()) {
      await this.flushSession(id);
    }
  }

  private async flushSession(id: string): Promise<void> {
    const pf = this.pendingFlush.get(id);
    if (!pf || pf.length === 0 || !this.apiBase) return;
    const batch = pf.splice(0, FLUSH_BATCH_MAX);
    try {
      await fetch(`${this.apiBase}/sessions/${id}/append`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: batch.map((b) => ({
            stream: b.stream, line: b.line, line_no: b.line_no,
            ts: new Date(b.ts).toISOString(),
          })),
        }),
      });
    } catch (e) {
      // Re-queue on failure (rate-limited to avoid runaway)
      pf.unshift(...batch);
    }
  }

  private async endBackend(id: string, exitCode: number, durationMs: number, status: string) {
    if (!this.apiBase) return;
    try {
      await fetch(`${this.apiBase}/sessions/${id}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exit_code: exitCode, duration_ms: durationMs, status }),
      });
    } catch {}
  }
}

export const sessionManager = new SessionManager();
