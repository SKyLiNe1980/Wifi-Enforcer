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
import { startStream, killStream, hasNativeStreaming } from "./rootShell";

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
  lines: LineRecord[];        // ring buffer
  lineCount: number;          // total lines ever (including dropped from ring)
  errorMessage?: string;
  mocked: boolean;
};

type Listener = () => void;

const RING_MAX = 1500;          // lines kept in memory per session
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
  async start(opts: { command: string; iface?: string; label?: string; id?: string; forceMock?: boolean }): Promise<string> {
    const id = opts.id || `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const state: SessionState = {
      id,
      command: opts.command,
      iface: opts.iface || "",
      label: opts.label || (opts.command.split(/\s+/)[0] || "session"),
      startedAt: Date.now(),
      status: "starting",
      lines: [],
      lineCount: 0,
      mocked: false,  // determined below via lazy probe
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
      // Preferred path — native batches lines and we apply them as one
      // push + one bounded splice + one notify per batch. This is what
      // keeps dmesg-style bursts (~30k lines/sec) from ANR'ing the JS thread.
      onLines: (e) => this.handleLinesBatch(id, e.stream, e.lines, e.toLineNo),
      // Fallback for any straggler `RootShell.line` events (PID was emitted
      // per-line, no other code path uses this now — but keep the listener
      // wired so old APKs that still emit it don't break.)
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

  /** Remove a session from local + backend memory (Mongo summary preserved). */
  async remove(id: string): Promise<void> {
    this.sessions.delete(id);
    this.pendingFlush.delete(id);
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
