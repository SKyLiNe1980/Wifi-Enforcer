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
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";
import { kvGet, kvSet } from "./localDb";
import { busStart, busStop, busUpdate, busNotify } from "./swatBus";
import { isSwatOp } from "./swatOps";

const KEY = "swat_config";
const SASL_PW_KEY = "swat_sasl_password"; // password never touches kv/SQLite

export type SwatConfig = {
  host: string;
  port: number;
  tls: boolean;          // ws (false) vs wss (true) — wss listener is :7779
  saslAccount: string;   // "" = SASL disabled (legacy NICK/USER only)
  nick: string;
  channel: string;
  realname: string;
  autoconnect: boolean;
  alertsEnabled: boolean; // heads-up notif on @mention / MISSION / HALT (bg)
};

export function defaultSwatConfig(): SwatConfig {
  return {
    host: "100.83.194.121",
    port: 7778,
    tls: false,
    saslAccount: "",
    nick: "Enforcer-Operator",
    channel: "#SWAT",
    realname: "Enforcer Operator",
    autoconnect: true,
    alertsEnabled: true,
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

export type OpsEcho = { nicks: string[]; at: number };
type State = {
  status: SwatStatus;
  roster: string[];
  events: SwatEvent[];
  nick: string;
  host: string;
  error: string | null;
  opsEcho: OpsEcho | null; // conductor's echoed ops list (display / drift only)
};

const MAX_EVENTS = 500;

let ws: WebSocket | null = null;
let wantConnected = false;
let reconnectTimer: any = null;
// Fallback: if IRC registration (→ 001) doesn't land shortly after the socket
// opens, force NICK/USER so a stalled CAP/SASL negotiation can't hang us into
// the server's "Registration timeout" kill.
let regTimer: any = null;
let attempts = 0; // exponential-backoff counter (reset on successful register)
let cfg: SwatConfig | null = null;
let uidN = 0;
let saslPassword = ""; // loaded from SecureStore at connect time

let state: State = {
  status: "down",
  roster: [],
  events: [],
  nick: "",
  host: "",
  error: null,
  opsEcho: null,
};

const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
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
  if (patch.status !== undefined) {
    busUpdate(state.status, state.nick, cfg?.channel || "#SWAT", `${state.roster.length} online`);
  }
}

export function isCommander(nick: string): boolean {
  // Static, local-only authorization (see swatOps.ts — "authorize static").
  return isSwatOp(nick);
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

// ── SASL credential storage ────────────────────────────────────────────────
// Password lives ONLY in expo-secure-store (AndroidKeyStore-backed). The
// account name is non-secret and rides along in the kv config.
export async function readSaslPassword(): Promise<string> {
  try { return (await SecureStore.getItemAsync(SASL_PW_KEY)) || ""; } catch { return ""; }
}
export async function writeSaslPassword(pw: string): Promise<void> {
  try {
    if (pw) await SecureStore.setItemAsync(SASL_PW_KEY, pw);
    else await SecureStore.deleteItemAsync(SASL_PW_KEY);
  } catch { /* noop */ }
}
export async function hasSaslPassword(): Promise<boolean> {
  return (await readSaslPassword()).length > 0;
}

// ── base64 (SASL PLAIN payload) ─────────────────────────────────────────────
// Hermes has no reliable btoa; roll a tiny UTF-8 → base64 encoder that also
// tolerates the NUL separators SASL PLAIN requires (\0account\0password).
function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}
function b64(bytes: number[]): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += A[b0 >> 2];
    out += A[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += i + 1 < bytes.length ? A[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)] : "=";
    out += i + 2 < bytes.length ? A[b2 & 63] : "=";
  }
  return out;
}
function saslPlainPayload(account: string, password: string): string {
  return b64([0, ...utf8Bytes(account), 0, ...utf8Bytes(password)]);
}

// ── IRC helpers ──────────────────────────────────────────────────────────
/** Strip mIRC control codes (colour \x03[n[,n]], bold, italic, underline, reset). */
export function stripIrc(s: string): string {
  return s.replace(/\x03\d{0,2}(,\d{1,2})?|[\x02\x0f\x1d\x1f\x16\x11]/g, "");
}

/** Public: let the UI dismiss the OPS-echo drift panel. */
export function clearOpsEcho() {
  set({ opsEcho: null });
}

// ── OPS echo (display / drift only — NEVER an authorization input) ──────────
// The conductor may ECHO its copy of the swat_ops file in reply to the `OPS`
// verb. We detect a line like "OPS: nickA nickB" or "commanders: a, b" and
// surface it so the operator can eyeball drift vs the app's shipped SWAT_OPS.
function parseOpsEcho(rawText: string): string[] | null {
  const text = stripIrc(rawText || "").trim();
  const m = text.match(/^(?:ops|commanders?)\b[\s:=\-]*(.+)$/i);
  if (!m) return null;
  const nicks = m[1]
    .split(/[\s,]+/)
    .map((n) => n.replace(/^[@+%~&]+/, "").trim())
    .filter(Boolean);
  return nicks.length ? nicks : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

// Fire a heads-up notification for a #SWAT event — ONLY while backgrounded
// (no point buzzing while the operator is staring at the live feed) and only
// for other people's traffic (skip our own echoes).
function maybeAlert(from: string, rawText: string) {
  if (!cfg?.alertsEnabled) return;
  if (!from || from === "*" || from === state.nick) return;
  if (AppState.currentState === "active") return; // foreground → feed is enough
  const text = stripIrc(rawText || "").trim();
  const me = (state.nick || cfg?.nick || "").toLowerCase();
  const verb = text.split(/\s+/)[0]?.toUpperCase() || "";
  const mentioned = !!me && new RegExp(`(^|[^\\w])@?${escapeRe(me)}([^\\w]|$)`, "i").test(text);
  if (mentioned) {
    busNotify(`@${from}`, text, "#3ad7ff");
  } else if (verb === "MISSION") {
    busNotify(`MISSION · ${from}`, text, "#ffd400");
  } else if (verb === "HALT" || verb === "ABORT") {
    busNotify(`${verb} · ${from}`, text, "#ff3860");
  }
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
    // ── IRCv3 CAP / SASL PLAIN negotiation ──────────────────────────────
    case "CAP": {
      const sub = (p.params[1] || "").toUpperCase();
      if (sub === "LS") {
        const offered = (p.trailing || "").toLowerCase().split(/\s+/);
        if (cfg?.saslAccount && saslPassword && offered.includes("sasl")) {
          rawSend("CAP REQ :sasl");
        } else {
          rawSend("CAP END");
          register();
        }
      } else if (sub === "ACK") {
        rawSend("AUTHENTICATE PLAIN");
      } else { // NAK / anything unexpected → give up on caps, register plain
        rawSend("CAP END");
        register();
      }
      break;
    }
    case "AUTHENTICATE":
      // Server ready for the credential blob.
      if (p.params[0] === "+" || p.trailing === "+") {
        rawSend(`AUTHENTICATE ${saslPlainPayload(cfg?.saslAccount || "", saslPassword)}`);
      }
      break;
    case "900": // RPL_LOGGEDIN (informational)
      break;
    case "903": // RPL_SASLSUCCESS
      pushEvent("*", "SASL auth ok", { system: true, color: "green" });
      rawSend("CAP END");
      register();
      break;
    case "902": // nick locked
    case "904": // SASL failed
    case "905": // message too long
    case "906": // aborted
    case "907": { // already authenticated
      // Degrade gracefully — end caps and register unauthenticated instead of
      // spinning. Commander gating still works off the static ops list.
      set({ error: `SASL failed (${p.command}) — connected without account` });
      pushEvent("*", `SASL auth failed (${p.command}) — continuing unauthenticated`, { system: true, color: "red" });
      rawSend("CAP END");
      register();
      break;
    }
    case "001": // welcome → join
      if (regTimer) { clearTimeout(regTimer); regTimer = null; }
      rawSend(`JOIN ${chan}`);
      pushEvent("*", `connected to ${state.host} — joining ${chan}`, { system: true, color: "grey" });
      attempts = 0; // successful registration → reset backoff
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
      const toChan = target === chan || target?.toLowerCase() === chan.toLowerCase();
      const toMe = target?.toLowerCase() === (state.nick || "").toLowerCase();
      // OPS echo (from the conductor / another op) → drift panel, any target.
      if (p.nick && p.nick !== state.nick) {
        const ops = parseOpsEcho(p.trailing);
        if (ops) set({ opsEcho: { nicks: ops, at: Date.now() } });
      }
      if (toChan) {
        pushEvent(p.nick || "?", p.trailing);
        maybeAlert(p.nick || "?", p.trailing);
      } else if (toMe) {
        // surface direct messages (e.g. conductor replies) in the feed too
        pushEvent(p.nick || "?", p.trailing);
        maybeAlert(p.nick || "?", p.trailing);
      }
      break;
    }
    case "NOTICE": {
      const target = p.params[0];
      const toChan = target === chan || target?.toLowerCase() === chan.toLowerCase();
      if (p.nick && p.nick !== state.nick) {
        const ops = parseOpsEcho(p.trailing);
        if (ops) set({ opsEcho: { nicks: ops, at: Date.now() } });
      }
      if (toChan && p.trailing) pushEvent(p.nick || "*", p.trailing);
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

/** Legacy registration handshake — sent after CAP END (or immediately when
 *  SASL is disabled). */
function register() {
  if (!cfg) return;
  rawSend(`NICK ${cfg.nick}`);
  rawSend(`USER ${cfg.nick} 0 * :${cfg.realname || cfg.nick}`);
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
  saslPassword = await readSaslPassword();
  wantConnected = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (regTimer) { clearTimeout(regTimer); regTimer = null; }
  if (ws) { try { ws.close(); } catch { /* noop */ } ws = null; }
  // Start the Android foreground service (keeps process + WS alive in bg).
  busStart(c.nick, c.channel);
  const scheme = c.tls ? "wss" : "ws";
  set({ status: "connecting", host: `${c.host}:${c.port}`, nick: c.nick, roster: [], error: null });
  try {
    const sock = new WebSocket(`${scheme}://${c.host}:${c.port}`);
    ws = sock;
    sock.onopen = () => {
      // If SASL is configured, negotiate caps FIRST; NICK/USER get sent from
      // the CAP/SASL state machine (register()). Otherwise register directly.
      if (c.saslAccount && saslPassword) {
        rawSend("CAP LS 302");
      } else {
        register();
      }
      // Safety net: if 001 hasn't arrived in 9s, the CAP/SASL handshake stalled
      // (or the server never answered) — abort caps and register plain so we
      // don't sit until Ergo kills us with "Registration timeout".
      if (regTimer) clearTimeout(regTimer);
      regTimer = setTimeout(() => {
        if (ws === sock && state.status !== "connected") {
          pushEvent("*", "registration slow — forcing NICK/USER (CAP END)", { system: true, color: "yellow" });
          rawSend("CAP END");
          register();
        }
      }, 9000);
    };
    sock.onmessage = (ev: any) => {
      const data: string = typeof ev.data === "string" ? ev.data : String(ev.data);
      data.split(/\r?\n/).forEach((ln) => handleLine(ln.trim()));
    };
    sock.onerror = () => {
      set({ error: "websocket error" });
    };
    sock.onclose = () => {
      // Ignore closes from a stale socket (a newer connectSwat() already
      // replaced it) so we can't double-schedule reconnects → storm.
      if (ws !== sock) return;
      ws = null;
      if (regTimer) { clearTimeout(regTimer); regTimer = null; }
      if (wantConnected) {
        // exponential backoff 1s → 60s cap; keep status "connecting" so the
        // LED/notification reads yellow while we retry.
        const delay = Math.min(60000, 1000 * 2 ** attempts);
        attempts += 1;
        set({ status: "connecting", roster: [] });
        reconnectTimer = setTimeout(() => { if (wantConnected) connectSwat(); }, delay);
      } else {
        set({ status: "down", roster: [] });
      }
    };
  } catch (e: any) {
    set({ status: "down", error: e?.message || "connect failed" });
  }
}

export function disconnectSwat() {
  wantConnected = false;
  attempts = 0;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (regTimer) { clearTimeout(regTimer); regTimer = null; }
  if (ws) { try { ws.close(); } catch { /* noop */ } ws = null; }
  busStop();
  set({ status: "down", roster: [] });
}
