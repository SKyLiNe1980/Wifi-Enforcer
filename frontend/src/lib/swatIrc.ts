/**
 * swatIrc — IRC-over-WebSocket client for the SWAT control plane (Ergo).
 *
 * Ergo speaks IRC natively on its WebSocket listener (ws://host:7778), so this
 * is a plain WebSocket that sends/receives raw IRC lines. Implements the Phase-A
 * contract from swat-app-tab-spec.md:
 *   connect → NICK/USER → (001) JOIN #SWAT → PING/PONG keepalive →
 *   parse PRIVMSG/NAMES/JOIN/PART → strip IRC control codes → verb-colour.
 *
 * Exposes a tiny singleton store (subscribe/getState) so the SWAT tab can render
 * live without prop drilling. Config persists in the localDb kv store.
 */
import { kvGet, kvSet } from "./localDb";

const KEY = "swat_config";

export type SwatConfig = {
  host: string;
  port: number;
  nick: string;
  channel: string;
  realname: string;
  autoconnect: boolean;
};

export function defaultSwatConfig(): SwatConfig {
  return {
    host: "100.83.194.121",
    port: 7778,
    nick: "Enforcer-Operator",
    channel: "#SWAT",
    realname: "Enforcer Operator",
    autoconnect: true,
  };
}

export type SwatStatus = "down" | "connecting" | "connected";
export type EventColor = "grey" | "yellow" | "green" | "red";
export type SwatEvent = {
  id: string;
  ts: number;
  from: string;
  text: string;
  color: EventColor;
  system?: boolean;
};

type State = {
  status: SwatStatus;
  roster: string[];
  events: SwatEvent[];
  nick: string;
  host: string;
  error: string | null;
};

const MAX_EVENTS = 500;
const COMMANDERS = ["Maarten", "Enforcer-Operator"]; // phase-A hardcoded (spec §4)

let ws: WebSocket | null = null;
let wantConnected = false;
let reconnectTimer: any = null;
let cfg: SwatConfig | null = null;
let uidN = 0;

let state: State = {
  status: "down",
  roster: [],
  events: [],
  nick: "",
  host: "",
  error: null,
};

const listeners = new Set<() => void>();
function emit() {
  const snap = state;
  listeners.forEach((l) => {
    state = snap;
    l();
  });
}
export function subscribeSwat(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function getSwatState(): State {
  return state;
}
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  emit();
}

export function isCommander(nick: string): boolean {
  return COMMANDERS.some((c) => c.toLowerCase() === (nick || "").toLowerCase());
}

export async function loadSwatConfig(): Promise<SwatConfig> {
  if (cfg) return cfg;
  const stored = await kvGet<SwatConfig>(KEY);
  cfg = stored ? { ...defaultSwatConfig(), ...stored } : defaultSwatConfig();
  return cfg;
}
export async function saveSwatConfig(next: SwatConfig): Promise<void> {
  cfg = next;
  await kvSet(KEY, next);
}

// ── IRC helpers ──────────────────────────────────────────────────────────
/** Strip mIRC control codes (colour \x03[n[,n]], bold, italic, underline, reset). */
export function stripIrc(s: string): string {
  return s.replace(/\x03\d{0,2}(,\d{1,2})?|[\x02\x0f\x1d\x1f\x16\x11]/g, "");
}

// mIRC 16-colour palette (indices 0-15). Dark entries are nudged lighter so
// they stay readable on the near-black feed background.
const MIRC: Record<number, string> = {
  0: "#ffffff", 1: "#c8d0cc", 2: "#5b8cff", 3: "#00ff66", 4: "#ff3860", 5: "#ff7a5c",
  6: "#c56bff", 7: "#ffb020", 8: "#ffd400", 9: "#7dff9a", 10: "#3ad7ff", 11: "#8bf0ff",
  12: "#7aa8ff", 13: "#ff77dd", 14: "#8aa39b", 15: "#c8d0cc",
};

export type ColoredSeg = { t: string; color: string | null };
/** Split a raw IRC message into coloured segments per its \x03 codes. */
export function parseIrcColored(raw: string): ColoredSeg[] {
  const segs: ColoredSeg[] = [];
  let cur = "";
  let color: string | null = null;
  const flush = () => { if (cur) { segs.push({ t: cur, color }); cur = ""; } };
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "\x03") {
      flush();
      let j = i + 1;
      let fg = "";
      while (j < raw.length && /\d/.test(raw[j]) && fg.length < 2) { fg += raw[j]; j += 1; }
      if (raw[j] === "," && /\d/.test(raw[j + 1] || "")) { // skip bg colour
        j += 1;
        let bg = "";
        while (j < raw.length && /\d/.test(raw[j]) && bg.length < 2) { j += 1; bg += "x"; }
      }
      color = fg === "" ? null : (MIRC[parseInt(fg, 10)] ?? null);
      i = j - 1;
    } else if (ch === "\x0f") { // reset
      flush();
      color = null;
    } else if ("\x02\x1d\x1f\x16\x11".includes(ch)) {
      // bold/italic/underline/reverse/mono — drop the toggle, keep text
    } else {
      cur += ch;
    }
  }
  flush();
  return segs.length ? segs : [{ t: raw, color: null }];
}

function verbColor(text: string): EventColor {
  const t = text.trim();
  const verb = t.split(/\s+/)[0]?.toUpperCase() || "";
  if (/^DONE\b/.test(t)) return /status:fail|:fail\b|\bfail\b/i.test(t) ? "red" : "green";
  if (verb === "COMPLETE") return "green";
  if (verb === "HALT" || verb === "ABORT") return "red";
  if (verb === "CLAIM" || verb === "TASK" || verb === "MISSION") return "yellow";
  return "grey"; // ORCH / ACK / state / everything else
}

function uid(): string {
  uidN += 1;
  return `e${Date.now().toString(36)}_${uidN}`;
}

function pushEvent(from: string, text: string, opts?: { system?: boolean; color?: EventColor }) {
  // Keep the RAW text (mIRC \x03 colour codes intact) so the app can honour
  // colours emitted by the TCL conductor. The verb-based `color` is only a
  // fallback for lines that arrive without any colour codes.
  const ev: SwatEvent = {
    id: uid(),
    ts: Date.now(),
    from,
    text,
    color: opts?.color ?? verbColor(stripIrc(text)),
    system: opts?.system,
  };
  const events = [...state.events, ev];
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  set({ events });
}

type Parsed = { prefix: string; nick: string; command: string; params: string[]; trailing: string };
function parseLine(line: string): Parsed {
  let rest = line;
  let prefix = "";
  let nick = "";
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    prefix = rest.slice(1, sp);
    nick = prefix.split("!")[0];
    rest = rest.slice(sp + 1);
  }
  let trailing = "";
  const ti = rest.indexOf(" :");
  if (rest.startsWith(":")) {
    trailing = rest.slice(1);
    rest = "";
  } else if (ti >= 0) {
    trailing = rest.slice(ti + 2);
    rest = rest.slice(0, ti);
  }
  const parts = rest.split(" ").filter(Boolean);
  const command = parts.shift() || "";
  return { prefix, nick, command: command.toUpperCase(), params: parts, trailing };
}

function stripNamePrefix(n: string): string {
  return n.replace(/^[@+%~&]+/, "");
}

function addRoster(n: string) {
  const clean = stripNamePrefix(n);
  if (!clean) return;
  if (!state.roster.includes(clean)) set({ roster: [...state.roster, clean].sort() });
}
function removeRoster(n: string) {
  const clean = stripNamePrefix(n);
  if (state.roster.includes(clean)) set({ roster: state.roster.filter((r) => r !== clean) });
}

function handleLine(line: string) {
  if (!line) return;
  if (line.startsWith("PING")) {
    const token = line.slice(4).replace(/^\s*:?/, "");
    rawSend(`PONG :${token}`);
    return;
  }
  const p = parseLine(line);
  const chan = cfg?.channel || "#SWAT";
  switch (p.command) {
    case "001": // welcome → join
      rawSend(`JOIN ${chan}`);
      pushEvent("*", `connected to ${state.host} — joining ${chan}`, { system: true, color: "grey" });
      set({ status: "connected", error: null });
      break;
    case "353": { // NAMES
      p.trailing.split(" ").filter(Boolean).forEach(addRoster);
      break;
    }
    case "JOIN":
      if (p.nick) {
        addRoster(p.nick);
        if (p.nick !== state.nick) pushEvent("*", `${p.nick} joined`, { system: true, color: "grey" });
      }
      break;
    case "PART":
    case "QUIT":
      if (p.nick) {
        removeRoster(p.nick);
        pushEvent("*", `${p.nick} left`, { system: true, color: "grey" });
      }
      break;
    case "NICK":
      if (p.nick) {
        removeRoster(p.nick);
        addRoster(p.trailing || p.params[0] || "");
      }
      break;
    case "PRIVMSG": {
      const target = p.params[0];
      if (target === chan || target?.toLowerCase() === chan.toLowerCase()) {
        pushEvent(p.nick || "?", p.trailing);
      }
      break;
    }
    case "PONG":
      break;
    case "ERROR":
      pushEvent("*", `server error: ${p.trailing}`, { system: true, color: "red" });
      break;
    default:
      break;
  }
}

function rawSend(line: string) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    // hard-cap per IRC 512-byte line limit (leave room for CRLF)
    ws.send(`${line.slice(0, 500)}\r\n`);
  }
}

/** Public: send a verb/PRIVMSG line to the channel. */
export function swatSend(text: string) {
  const chan = cfg?.channel || "#SWAT";
  const t = text.trim();
  if (!t) return;
  rawSend(`PRIVMSG ${chan} :${t}`);
  // echo locally (Ergo won't echo our own PRIVMSG back without echo-message cap)
  pushEvent(state.nick || "me", t, { color: verbColor(t) });
}

export async function connectSwat() {
  const c = await loadSwatConfig();
  wantConnected = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch { /* noop */ } ws = null; }
  set({ status: "connecting", host: `${c.host}:${c.port}`, nick: c.nick, roster: [], error: null });
  try {
    const sock = new WebSocket(`ws://${c.host}:${c.port}`);
    ws = sock;
    sock.onopen = () => {
      rawSend(`NICK ${c.nick}`);
      rawSend(`USER ${c.nick} 0 * :${c.realname || c.nick}`);
    };
    sock.onmessage = (ev: any) => {
      const data: string = typeof ev.data === "string" ? ev.data : String(ev.data);
      data.split(/\r?\n/).forEach((ln) => handleLine(ln.trim()));
    };
    sock.onerror = () => {
      set({ error: "websocket error" });
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      set({ status: "down", roster: [] });
      if (wantConnected) {
        reconnectTimer = setTimeout(() => { if (wantConnected) connectSwat(); }, 4000);
      }
    };
  } catch (e: any) {
    set({ status: "down", error: e?.message || "connect failed" });
  }
}

export function disconnectSwat() {
  wantConnected = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch { /* noop */ } ws = null; }
  set({ status: "down", roster: [] });
}
