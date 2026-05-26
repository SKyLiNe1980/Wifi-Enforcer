import { NativeModules, NativeEventEmitter, Platform } from "react-native";

/**
 * Thin wrapper around the native RootShell module.
 *
 * Synchronous API (blocks until command exits — DO NOT USE for airodump/wifite/tcpdump):
 *   checkRoot()
 *   execReal(cmd)
 *   RootShell.execBatch(cmds)
 *
 * Streaming API (preferred for long-running tools):
 *   startStream(sessionId, command, { onLine, onPid, onExit, onError })
 *      -> returns an unsubscribe function that removes all listeners.
 *   killStream(sessionId, graceful)
 *   listStreams()
 *
 * Falls back to mocked HTTP backend in Expo Go / web preview.
 */

type LineEvent = { sessionId: string; stream: "stdout" | "stderr"; line: string; lineNo: number };
type ExitEvent = { sessionId: string; exit_code: number; duration_ms: number; line_count: number };
type ErrorEvent = { sessionId: string; message: string };
type PidEvent = { sessionId: string; pid: number };

type RNModule = {
  isRoot(): Promise<boolean>;
  exec(cmd: string): Promise<{
    command: string; stdout: string; stderr: string;
    exit_code: number; duration_ms: number;
  }>;
  execBatch(cmds: string[]): Promise<{
    logs: { command: string; stdout: string; stderr: string; exit_code: number }[];
    duration_ms: number;
  }>;
  // Streaming
  executeStream(sessionId: string, command: string): Promise<string>;
  killSession(sessionId: string, graceful: boolean): Promise<boolean>;
  listSessions(): Promise<Array<{
    sessionId: string; command: string; pid: number; started_at: number; line_count: number;
  }>>;
};

export const RootShell: RNModule | null =
  Platform.OS === "android" ? (NativeModules as any).RootShell || null : null;

export const HAS_NATIVE_ROOT = !!RootShell;

/**
 * Whether the native module exposes the streaming API (executeStream, killSession, …).
 *
 * IMPORTANT: We deliberately do NOT compute this at module-evaluation time as
 * `typeof RootShell.executeStream === 'function'` — the RN legacy bridge is
 * sometimes still building its method table when this file is imported, so
 * the typeof check returns `undefined` even though the method is registered.
 * Instead we check lazily at each use site.
 */
export function hasNativeStreaming(): boolean {
  if (!RootShell) return false;
  const m = RootShell as any;
  return typeof m.executeStream === "function" || typeof m.executeStream === "object";
}

// Back-compat constant — optimistic; assumes if root works, streaming ships with it.
// Real check happens at call time via hasNativeStreaming().
export const HAS_NATIVE_STREAMING = !!RootShell;

// One-shot diagnostic — logs the actual method shape so we can see what
// RN's bridge is exposing. Helps debug "module loaded but methods missing".
if (RootShell) {
  try {
    const keys = Object.keys(RootShell as any);
    const exec = typeof (RootShell as any).executeStream;
    const kill = typeof (RootShell as any).killSession;
    // eslint-disable-next-line no-console
    console.log(`[RootShell] bridge probe: keys=${keys.join(",")} executeStream=${exec} killSession=${kill}`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[RootShell] probe failed", e);
  }
}

const emitter = RootShell ? new NativeEventEmitter(NativeModules.RootShell) : null;

export async function checkRoot(): Promise<boolean> {
  if (!RootShell) return false;
  try { return await RootShell.isRoot(); } catch { return false; }
}

export async function execReal(cmd: string) {
  if (!RootShell) throw new Error("native root module not available");
  const r = await RootShell.exec(cmd);
  return {
    command: r.command,
    output: r.stdout || r.stderr || "",
    exit_code: r.exit_code,
    duration_ms: r.duration_ms,
    mocked: false,
  };
}

export type StreamCallbacks = {
  onLine?: (e: LineEvent) => void;
  onExit?: (e: ExitEvent) => void;
  onError?: (e: ErrorEvent) => void;
  onPid?: (e: PidEvent) => void;
};

/**
 * Start a streaming session. Returns an unsubscribe function that removes the
 * listeners (call it on cleanup). The session itself continues running until
 * it exits or you call killStream().
 */
export function startStream(
  sessionId: string,
  command: string,
  cb: StreamCallbacks,
): () => void {
  if (!RootShell || !emitter) {
    // Fallback: immediately error so caller knows
    setTimeout(() => cb.onError?.({ sessionId, message: "native streaming unavailable" }), 0);
    return () => {};
  }
  const subs = [
    emitter.addListener("RootShell.line", (e: LineEvent) => { if (e.sessionId === sessionId) cb.onLine?.(e); }),
    emitter.addListener("RootShell.exit", (e: ExitEvent) => { if (e.sessionId === sessionId) cb.onExit?.(e); }),
    emitter.addListener("RootShell.error", (e: ErrorEvent) => { if (e.sessionId === sessionId) cb.onError?.(e); }),
    emitter.addListener("RootShell.pid", (e: PidEvent) => { if (e.sessionId === sessionId) cb.onPid?.(e); }),
  ];

  try {
    RootShell.executeStream(sessionId, command)
      .then(() => { /* native ack */ })
      .catch((err: any) => {
        cb.onError?.({ sessionId, message: err?.message || "executeStream failed" });
      });
  } catch (e: any) {
    // Method literally doesn't exist on the bridge (old APK, build mismatch, etc.)
    cb.onError?.({ sessionId, message: `streaming method missing: ${e?.message || e}` });
  }

  return () => { subs.forEach((s) => s.remove()); };
}

export async function killStream(sessionId: string, graceful: boolean): Promise<boolean> {
  if (!RootShell) return false;
  try { return await RootShell.killSession(sessionId, graceful); } catch { return false; }
}

export async function listStreams() {
  if (!RootShell) return [];
  try { return await RootShell.listSessions(); } catch { return []; }
}
