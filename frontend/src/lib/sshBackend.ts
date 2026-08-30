import { NativeModules, NativeEventEmitter, Platform } from "react-native";
import type { StreamCallbacks } from "./rootShell";

/**
 * sshBackend — JS wrapper around the native SshShell module. Mirrors the
 * rootShell.ts streaming contract (startStream / killStream / writeStdin /
 * resizeSession) so the backend selector can use either transport
 * interchangeably. Adds connect/disconnect/host-key plumbing specific to SSH.
 */

export type SshConnectConfig = {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;   // PEM
  passphrase?: string;
};

export type SshStateEvent = { state: "connected" | "down" | "error"; detail: string };
export type SshHostKeyEvent = { host: string; fingerprint: string; keyType: string };

type RNModule = {
  connect(config: SshConnectConfig): Promise<boolean>;
  disconnect(): Promise<boolean>;
  isConnected(): Promise<boolean>;
  executeStream(sessionId: string, command: string): Promise<string>;
  killSession(sessionId: string, graceful: boolean): Promise<boolean>;
  writeStdin(sessionId: string, text: string, appendNewline: boolean): Promise<number>;
  resizeSession(sessionId: string, cols: number, rows: number): Promise<boolean>;
  listSessions(): Promise<{ sessionId: string; pid: number }[]>;
};

export const SshShell: RNModule | null =
  Platform.OS === "android" ? (NativeModules as any).SshShell || null : null;

export const HAS_NATIVE_SSH = !!SshShell;

let emitter: NativeEventEmitter | null = null;
try {
  if (SshShell) emitter = new NativeEventEmitter(NativeModules.SshShell as any);
} catch (e) {
  console.warn("[SshShell] NativeEventEmitter init failed", e);
  emitter = null;
}

export async function sshConnect(config: SshConnectConfig): Promise<boolean> {
  if (!SshShell) throw new Error("native SSH module not available");
  return SshShell.connect(config);
}

export async function sshDisconnect(): Promise<void> {
  if (!SshShell) return;
  try { await SshShell.disconnect(); } catch { /* noop */ }
}

export async function sshIsConnected(): Promise<boolean> {
  if (!SshShell) return false;
  try { return await SshShell.isConnected(); } catch { return false; }
}

/** Subscribe to connection-state changes. Returns an unsubscribe fn. */
export function onSshState(cb: (e: SshStateEvent) => void): () => void {
  if (!emitter) return () => {};
  const sub = emitter.addListener("SshShell.state", cb);
  return () => sub.remove();
}

/** Subscribe to host-key reports (for trust-on-first-use). Returns unsubscribe. */
export function onSshHostKey(cb: (e: SshHostKeyEvent) => void): () => void {
  if (!emitter) return () => {};
  const sub = emitter.addListener("SshShell.hostkey", cb);
  return () => sub.remove();
}

/** Same shape as rootShell.startStream — routes over the SSH channel. */
export function startStream(sessionId: string, command: string, cb: StreamCallbacks): () => void {
  if (!SshShell || !emitter) {
    setTimeout(() => cb.onError?.({ sessionId, message: "native SSH unavailable" }), 0);
    return () => {};
  }
  const subs = [
    emitter.addListener("SshShell.chunk", (e: any) => { if (e.sessionId === sessionId) cb.onChunk?.(e); }),
    emitter.addListener("SshShell.exit", (e: any) => { if (e.sessionId === sessionId) cb.onExit?.(e); }),
    emitter.addListener("SshShell.error", (e: any) => { if (e.sessionId === sessionId) cb.onError?.(e); }),
  ];
  try {
    SshShell.executeStream(sessionId, command).catch((err: any) => {
      cb.onError?.({ sessionId, message: err?.message || "executeStream failed" });
    });
  } catch (e: any) {
    cb.onError?.({ sessionId, message: `ssh exec missing: ${e?.message || e}` });
  }
  return () => { subs.forEach((s) => s.remove()); };
}

export async function killStream(sessionId: string, graceful: boolean): Promise<boolean> {
  if (!SshShell) return false;
  try { return await SshShell.killSession(sessionId, graceful); } catch { return false; }
}

export async function writeStdin(sessionId: string, text: string, appendNewline: boolean = true): Promise<number> {
  if (!SshShell) return 0;
  try { return await SshShell.writeStdin(sessionId, text, appendNewline); } catch { return 0; }
}

export async function resizeSession(sessionId: string, cols: number, rows: number): Promise<boolean> {
  if (!SshShell) return false;
  try { return await SshShell.resizeSession(sessionId, cols, rows); } catch { return false; }
}

export async function listStreams() {
  if (!SshShell) return [];
  try { return await SshShell.listSessions(); } catch { return []; }
}

// ── one-shot exec (matches rootShell.execReal shape) ────────────────────────
// Built on the existing native executeStream (ChannelExec) — no native rebuild
// needed. Buffers stdout until the channel exits.
function b64ToUtf8(b64: string): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = (b64 || "").replace(/[^A-Za-z0-9+/=]/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const e0 = A.indexOf(clean[i]);
    const e1 = A.indexOf(clean[i + 1]);
    const e2 = A.indexOf(clean[i + 2]);
    const e3 = A.indexOf(clean[i + 3]);
    const c0 = (e0 << 2) | (e1 >> 4);
    bytes.push(c0);
    if (clean[i + 2] !== "=" && e2 >= 0) bytes.push(((e1 & 15) << 4) | (e2 >> 2));
    if (clean[i + 3] !== "=" && e3 >= 0) bytes.push(((e2 & 3) << 6) | e3);
  }
  // decode UTF-8
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    if (b < 0x80) { out += String.fromCharCode(b); i += 1; }
    else if (b >= 0xc0 && b < 0xe0) { out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2; }
    else if (b >= 0xe0) { out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3; }
    else { i += 1; }
  }
  return out;
}

export function execReal(
  command: string,
  timeoutMs: number = 20000,
): Promise<{ command: string; output: string; exit_code: number; duration_ms: number; mocked: boolean }> {
  return new Promise((resolve) => {
    if (!SshShell) {
      resolve({ command, output: "", exit_code: -1, duration_ms: 0, mocked: false });
      return;
    }
    const sid = `xr-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const started = Date.now();
    let out = "";
    let done = false;
    let stop: () => void = () => {};
    const finish = (code: number) => {
      if (done) return;
      done = true;
      try { stop(); } catch { /* noop */ }
      resolve({ command, output: out, exit_code: code, duration_ms: Date.now() - started, mocked: false });
    };
    stop = startStream(sid, command, {
      onChunk: (e: any) => { try { out += b64ToUtf8(e.dataB64 || ""); } catch { /* noop */ } },
      onExit: (e: any) => finish(typeof e.exit_code === "number" ? e.exit_code : 0),
      onError: () => finish(-1),
    });
    setTimeout(() => finish(out ? 0 : -1), timeoutMs);
  });
}
