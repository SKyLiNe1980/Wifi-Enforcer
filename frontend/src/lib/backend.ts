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

export function setActiveBackend(k: BackendKind): void { active = k; }
export function getActiveBackend(): BackendKind { return active; }

export function startStream(sessionId: string, command: string, cb: StreamCallbacks): () => void {
  return active === "ssh"
    ? ssh.startStream(sessionId, command, cb)
    : chroot.startStream(sessionId, command, cb);
}

export function killStream(sessionId: string, graceful: boolean): Promise<boolean> {
  return active === "ssh"
    ? ssh.killStream(sessionId, graceful)
    : chroot.killStream(sessionId, graceful);
}

export function writeStdin(sessionId: string, text: string, appendNewline: boolean = true): Promise<number> {
  return active === "ssh"
    ? ssh.writeStdin(sessionId, text, appendNewline)
    : chroot.writeStdin(sessionId, text, appendNewline);
}

export function resizeSession(sessionId: string, cols: number, rows: number): Promise<boolean> {
  return active === "ssh"
    ? ssh.resizeSession(sessionId, cols, rows)
    : chroot.resizeSession(sessionId, cols, rows);
}

/** Is the active backend's streaming transport present? */
export function hasStreaming(): boolean {
  return active === "ssh" ? ssh.HAS_NATIVE_SSH : chroot.hasNativeStreaming();
}

/** One-shot exec on the active backend. Same shape as rootShell.execReal. */
export function execReal(command: string) {
  return active === "ssh" ? ssh.execReal(command) : chroot.execReal(command);
}
