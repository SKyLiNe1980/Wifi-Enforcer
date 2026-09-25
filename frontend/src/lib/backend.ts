import * as chroot from "./rootShell";
import * as ssh from "./sshBackend";
import type { StreamCallbacks } from "./rootShell";

/**
 * backend — transport selector. Routes the streaming primitives to either the
 * local su→chroot pipe (RootShell) or an SSH session (SshShell) based on the
 * active backend. sessionManager imports from HERE instead of rootShell so a
 * single flag swaps the whole "kali backend". Defaults to chroot — nothing
 * changes until the operator explicitly enables SSH mode.
 */

export type BackendKind = "chroot" | "ssh";

let active: BackendKind = "chroot";

// Per-session transport binding. A session is pinned to the backend it was
// STARTED on, so writeStdin/kill/resize always route to the right transport
// even when the global `active` backend differs. This lets the Terminal keep
// a Kali/SSH shell AND a local/root (chroot) shell alive simultaneously — the
// focused view can flip between them without breaking either session's I/O.
const sessionKind = new Map<string, BackendKind>();
function kindFor(id: string): BackendKind { return sessionKind.get(id) ?? active; }

export function setActiveBackend(k: BackendKind): void { active = k; }
export function getActiveBackend(): BackendKind { return active; }

export function startStream(sessionId: string, command: string, cb: StreamCallbacks, kind?: BackendKind): () => void {
  const k = kind ?? active;
  sessionKind.set(sessionId, k);
  return k === "ssh"
    ? ssh.startStream(sessionId, command, cb)
    : chroot.startStream(sessionId, command, cb);
}

export function killStream(sessionId: string, graceful: boolean): Promise<boolean> {
  return kindFor(sessionId) === "ssh"
    ? ssh.killStream(sessionId, graceful)
    : chroot.killStream(sessionId, graceful);
}

export function writeStdin(sessionId: string, text: string, appendNewline: boolean = true): Promise<number> {
  return kindFor(sessionId) === "ssh"
    ? ssh.writeStdin(sessionId, text, appendNewline)
    : chroot.writeStdin(sessionId, text, appendNewline);
}

export function resizeSession(sessionId: string, cols: number, rows: number): Promise<boolean> {
  return kindFor(sessionId) === "ssh"
    ? ssh.resizeSession(sessionId, cols, rows)
    : chroot.resizeSession(sessionId, cols, rows);
}

/** Is the given (or active) backend's streaming transport present? */
export function hasStreaming(kind?: BackendKind): boolean {
  return (kind ?? active) === "ssh" ? ssh.HAS_NATIVE_SSH : chroot.hasNativeStreaming();
}

/** One-shot exec on the active backend. Same shape as rootShell.execReal. */
export function execReal(command: string) {
  return active === "ssh" ? ssh.execReal(command) : chroot.execReal(command);
}
