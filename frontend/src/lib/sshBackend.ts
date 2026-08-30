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
