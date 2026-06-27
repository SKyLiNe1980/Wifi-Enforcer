"""Real PTY-backed session manager for Phase 1C.

Replaces the Phase 1B stubs in `internal.py`. Each session is a long-lived
subprocess attached to a pseudo-terminal pair, with its output continuously
drained into a bounded ring buffer that MCP clients can sample via
`read_session`. Designed for interactive curses tools (wifite, msfconsole,
nmcli, etc.) where line-buffered subprocess.PIPE would lock up.

Key design points:

* **Real PTY, not pipes.** `pty.openpty()` gives us a master/slave fd pair.
  The child execs with slave on 0/1/2 and we explicitly do `TIOCSCTTY` so
  ncurses + readline behave correctly.
* **Process group isolation.** `os.setsid()` in preexec creates a fresh
  session so we can `killpg` the whole tree (think msfconsole spawning
  worker threads) without leaving zombies.
* **Non-blocking master + event-loop reader.** `loop.add_reader` drains
  the PTY into a ring buffer as soon as bytes arrive — no polling loop,
  no busy thread. The ring is a `bytearray` capped at `ring_cap` (default
  64 KiB), trimmed in-place when overflowing.
* **Concurrent-safe writes.** A per-session `asyncio.Lock` serializes
  `os.write` calls so multiple LLM clients don't interleave half-commands.
* **Auto-cleanup.** `proc.wait()` runs as a background task; on EOF we
  remove the reader, close the master fd, and stamp `exit_code`. Stale
  sessions linger in the registry (so `list_sessions` can show their
  final state) until either `stop_session` or `shutdown_all` purges them.

Caveats:
* PTY only works on Unix. The chroot is Linux, so no portability concern.
* Ring is byte-based; for a streaming/follow API (Phase 1D), we'll layer
  an offset cursor on top so clients can pull "since byte N".
"""
from __future__ import annotations

import asyncio
import fcntl
import os
import pty
import signal
import struct
import termios
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


# Ring buffer size per session. 64 KiB holds ~1000 lines of typical tool
# output — enough for a wifite/msfconsole scrollback while keeping memory
# bounded if dozens of sessions are open across the swarm.
DEFAULT_RING_CAP = 64 * 1024
DEFAULT_MAX_SESSIONS = 16


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Session:
    """One PTY-backed subprocess + its output ring buffer."""

    __slots__ = (
        "id", "label", "command", "master_fd", "proc",
        "ring", "ring_cap", "bytes_total",
        "created_at", "exit_code",
        "write_lock", "_waiter_task", "_reader_attached",
    )

    def __init__(
        self,
        sid: str,
        label: str,
        command: str,
        master_fd: int,
        proc: asyncio.subprocess.Process,
        ring_cap: int,
    ) -> None:
        self.id = sid
        self.label = label or ""
        self.command = command
        self.master_fd = master_fd
        self.proc = proc
        self.ring: bytearray = bytearray()
        self.ring_cap = ring_cap
        self.bytes_total = 0  # cumulative — survives ring trim
        self.created_at = _now_iso()
        self.exit_code: Optional[int] = None
        self.write_lock = asyncio.Lock()
        self._waiter_task: Optional[asyncio.Task] = None
        self._reader_attached: bool = False

    @property
    def running(self) -> bool:
        return self.exit_code is None and self.proc.returncode is None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "session_id": self.id,
            "label": self.label,
            "command": self.command,
            "pid": self.proc.pid,
            "running": self.running,
            "exit_code": self.exit_code if not self.running else None,
            "created_at": self.created_at,
            "buffer_bytes": len(self.ring),
            "total_bytes": self.bytes_total,
        }


class SessionManager:
    """Owns all active PTY sessions. Initialised once at server startup."""

    def __init__(
        self,
        ring_cap: int = DEFAULT_RING_CAP,
        max_sessions: int = DEFAULT_MAX_SESSIONS,
        logger=None,
    ) -> None:
        self._sessions: Dict[str, Session] = {}
        self.ring_cap = ring_cap
        self.max_sessions = max_sessions
        self._registry_lock = asyncio.Lock()
        # Optional structured logger (server.log function). Used so we get
        # the same JSON stdout lines as everything else without dragging in
        # Python's logging module.
        self._log = logger or (lambda *a, **kw: None)

    # ── lifecycle ──────────────────────────────────────────────────────
    async def start(
        self,
        command: str,
        label: str = "",
        cols: int = 120,
        rows: int = 32,
    ) -> Session:
        async with self._registry_lock:
            # Purge oldest exited sessions if we're at the cap — keeps the
            # registry from filling up with stale crashed runs.
            if len(self._sessions) >= self.max_sessions:
                self._garbage_collect_locked()
            if len(self._sessions) >= self.max_sessions:
                raise RuntimeError(
                    f"max sessions reached ({self.max_sessions}); "
                    "stop_session some before starting more"
                )

            master_fd, slave_fd = pty.openpty()
            try:
                self._set_winsize(slave_fd, cols, rows)
                self._set_nonblocking(master_fd)

                # Preexec runs in the forked child between fork() and exec().
                # We want: new session + slave as controlling terminal so
                # ncurses / readline / job-control all behave correctly.
                def _preexec() -> None:
                    os.setsid()
                    try:
                        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
                    except OSError:
                        # Already a ctty or kernel disagrees — non-fatal.
                        pass

                # `bash -c` so we can take a full command string (with
                # pipes, redirects, env, etc.) instead of an argv list.
                proc = await asyncio.create_subprocess_exec(
                    "bash", "-c", command,
                    stdin=slave_fd,
                    stdout=slave_fd,
                    stderr=slave_fd,
                    preexec_fn=_preexec,
                    close_fds=True,
                )
            except BaseException:
                # Don't leak fds if the subprocess launch blows up.
                try:
                    os.close(master_fd)
                except OSError:
                    pass
                try:
                    os.close(slave_fd)
                except OSError:
                    pass
                raise

            # Parent doesn't need the slave end after the child has it dup'd.
            try:
                os.close(slave_fd)
            except OSError:
                pass

            sid = uuid.uuid4().hex[:12]
            sess = Session(sid, label, command, master_fd, proc, self.ring_cap)
            self._sessions[sid] = sess

            # Attach the loop reader: drains the PTY into the ring buffer
            # whenever the kernel signals readability. No polling.
            loop = asyncio.get_running_loop()
            loop.add_reader(master_fd, self._on_readable, sess)
            sess._reader_attached = True

            # Background task: await process exit so we can stamp exit_code
            # and tear down the loop reader exactly once.
            sess._waiter_task = asyncio.create_task(self._waiter(sess))

            self._log("info", "session.started",
                      session_id=sid, label=label, pid=proc.pid, command=command)
            return sess

    async def write(self, sid: str, data: str, newline: bool = True) -> Dict[str, Any]:
        sess = self._require(sid)
        if not sess.running:
            raise RuntimeError(f"session {sid} is not running")
        payload = data.encode("utf-8", errors="replace")
        if newline and not payload.endswith(b"\n"):
            payload += b"\n"
        # Lock so two concurrent writes don't interleave a half-command.
        async with sess.write_lock:
            await asyncio.to_thread(os.write, sess.master_fd, payload)
        return {
            "session_id": sid,
            "bytes_written": len(payload),
            "running": sess.running,
        }

    async def read(
        self,
        sid: str,
        tail_bytes: int = 4096,
        clear: bool = False,
    ) -> Dict[str, Any]:
        sess = self._require(sid)
        tail_bytes = max(0, min(tail_bytes, sess.ring_cap))
        snapshot = bytes(sess.ring[-tail_bytes:]) if tail_bytes else b""
        if clear:
            sess.ring.clear()
        return {
            "session_id": sid,
            "bytes": snapshot.decode("utf-8", errors="replace"),
            "len": len(snapshot),
            "buffer_bytes": len(sess.ring),
            "total_bytes": sess.bytes_total,
            "running": sess.running,
            "exit_code": sess.exit_code if not sess.running else None,
        }

    async def stop(self, sid: str, sig_name: str = "SIGTERM") -> Dict[str, Any]:
        sess = self._require(sid)
        if not sess.running:
            return {
                "session_id": sid,
                "already_exited": True,
                "exit_code": sess.exit_code,
            }
        sig = getattr(signal, sig_name, signal.SIGTERM)
        # killpg so children (msfconsole workers, etc.) die too.
        try:
            os.killpg(os.getpgid(sess.proc.pid), sig)
        except (ProcessLookupError, PermissionError):
            try:
                sess.proc.send_signal(sig)
            except ProcessLookupError:
                pass

        # Give the process up to 2s to wind down, then SIGKILL the group.
        try:
            await asyncio.wait_for(sess.proc.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            try:
                os.killpg(os.getpgid(sess.proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                await asyncio.wait_for(sess.proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                pass

        self._log("info", "session.stopped",
                  session_id=sid, exit_code=sess.exit_code, sig=sig_name)
        return {
            "session_id": sid,
            "exit_code": sess.exit_code,
            "running": sess.running,
        }

    async def resize(self, sid: str, cols: int, rows: int) -> Dict[str, Any]:
        sess = self._require(sid)
        if not sess.running:
            raise RuntimeError(f"session {sid} is not running")
        self._set_winsize(sess.master_fd, cols, rows)
        return {"session_id": sid, "cols": cols, "rows": rows}

    async def list_all(self) -> List[Dict[str, Any]]:
        return [s.to_dict() for s in self._sessions.values()]

    async def shutdown_all(self) -> None:
        """Best-effort terminate every session on server shutdown."""
        ids = list(self._sessions.keys())
        for sid in ids:
            try:
                await self.stop(sid, sig_name="SIGTERM")
            except Exception as e:
                self._log("warn", "session.shutdown.fail", session_id=sid, err=str(e))

    # ── internals ──────────────────────────────────────────────────────
    def _require(self, sid: str) -> Session:
        sess = self._sessions.get(sid)
        if sess is None:
            raise KeyError(f"unknown session_id: {sid}")
        return sess

    def _on_readable(self, sess: Session) -> None:
        """loop.add_reader callback: drain PTY → ring buffer."""
        try:
            chunk = os.read(sess.master_fd, 8192)
        except BlockingIOError:
            return  # spurious wakeup
        except OSError:
            # Master fd closed (process exited). Waiter will tidy up.
            return
        if not chunk:
            # EOF on master — child closed all references to slave.
            return
        sess.ring.extend(chunk)
        sess.bytes_total += len(chunk)
        # Trim oldest bytes if we've overflowed the cap.
        overflow = len(sess.ring) - sess.ring_cap
        if overflow > 0:
            del sess.ring[:overflow]

    async def _waiter(self, sess: Session) -> None:
        """Await process exit, then clean up the loop reader + master fd."""
        try:
            rc = await sess.proc.wait()
        except Exception as e:
            self._log("warn", "session.waiter.exception",
                      session_id=sess.id, err=str(e))
            rc = -1
        sess.exit_code = rc
        # Final drain — pull any bytes the kernel queued after exit.
        try:
            while True:
                chunk = os.read(sess.master_fd, 8192)
                if not chunk:
                    break
                sess.ring.extend(chunk)
                sess.bytes_total += len(chunk)
        except (OSError, BlockingIOError):
            pass
        # Detach reader exactly once. add_reader/remove_reader is idempotent
        # in theory, but guarded for paranoia.
        if sess._reader_attached:
            try:
                asyncio.get_running_loop().remove_reader(sess.master_fd)
            except Exception:
                pass
            sess._reader_attached = False
        try:
            os.close(sess.master_fd)
        except OSError:
            pass
        # Final overflow trim
        overflow = len(sess.ring) - sess.ring_cap
        if overflow > 0:
            del sess.ring[:overflow]

    def _garbage_collect_locked(self) -> None:
        """Drop the oldest exited sessions to free room. Called under the
        registry lock when we hit max_sessions."""
        exited = [
            (sid, s) for sid, s in self._sessions.items() if not s.running
        ]
        # Drop oldest first
        exited.sort(key=lambda kv: kv[1].created_at)
        for sid, _ in exited:
            self._sessions.pop(sid, None)
            self._log("info", "session.gc", session_id=sid)
            if len(self._sessions) < self.max_sessions:
                break

    @staticmethod
    def _set_winsize(fd: int, cols: int, rows: int) -> None:
        # TIOCSWINSZ struct is rows, cols, xpix, ypix (all u16, host order).
        winsize = struct.pack("HHHH", max(1, rows), max(1, cols), 0, 0)
        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
        except OSError:
            pass

    @staticmethod
    def _set_nonblocking(fd: int) -> None:
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)


# Module-level singleton. server.py calls `init_session_manager(...)` once
# during startup, then internal.py's handlers use `get_session_manager()`.
_MANAGER: Optional[SessionManager] = None


def init_session_manager(
    ring_cap: int = DEFAULT_RING_CAP,
    max_sessions: int = DEFAULT_MAX_SESSIONS,
    logger=None,
) -> SessionManager:
    global _MANAGER
    _MANAGER = SessionManager(
        ring_cap=ring_cap, max_sessions=max_sessions, logger=logger,
    )
    return _MANAGER


def get_session_manager() -> SessionManager:
    if _MANAGER is None:
        # Lazy-init with defaults — useful for unit tests that import the
        # handlers without going through server.py.
        return init_session_manager()
    return _MANAGER
