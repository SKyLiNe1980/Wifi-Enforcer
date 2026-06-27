"""
In-process handlers for tools whose command_template = '__internal:<name>'.

Phase 1B shipped these as stubs. Phase 1C wires the four session ops
(start/write/read/stop) plus two new ones (list/resize) to the real
PTY-backed `SessionManager` in `handlers.sessions`. The remaining stubs
(attack_profiles dispatch) land in Phase 1D when we agree on the cockpit
SQLite IPC scheme.

Each handler is `async (args, conn) -> dict`. `conn` is the audit-DB
sqlite3 connection (kept for read_command_logs); the session manager is
a module-level singleton so we don't need a parallel signature.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any, Awaitable, Callable, Dict, List

from .sessions import get_session_manager


async def _read_command_logs(args: Dict[str, Any], conn: sqlite3.Connection) -> Dict[str, Any]:
    """Return recent rows from the MCP server's OWN audit log.

    NOTE: This is the *server-side* audit (every tool call routed through MCP).
    Phase 1D will add a sibling handler that reads the *cockpit's* SQLite
    command_logs table once we wire the IPC.
    """
    limit = int(args.get("limit", 50))
    limit = max(1, min(limit, 200))
    cursor = conn.execute(
        """SELECT id, ts, tool_name, args_json, result_summary, client_id,
                  duration_ms, exit_code, success
           FROM audit_log ORDER BY id DESC LIMIT ?""",
        (limit,),
    )
    rows = cursor.fetchall()
    logs: List[Dict[str, Any]] = []
    for r in rows:
        logs.append({
            "id": r[0], "ts": r[1], "tool_name": r[2],
            "args": json.loads(r[3] or "{}"),
            "result_summary": r[4], "client_id": r[5],
            "duration_ms": r[6], "exit_code": r[7], "success": bool(r[8]),
        })
    return {"logs": logs, "count": len(logs)}


async def _list_attack_profiles(args: Dict[str, Any], conn: sqlite3.Connection) -> Dict[str, Any]:
    """Stub: list attack profiles known to this node.

    In Phase 1D this will read from the cockpit's attack_profiles table
    (shared SQLite or HTTP callback to cockpit). For now we advertise the
    canonical NetHunter trio so MCP clients can at least probe the schema.
    """
    return {
        "profiles": [
            {"name": "airodump_scan",
             "description": "Channel-hopping scan with airodump-ng",
             "command": "airodump-ng {iface}"},
            {"name": "wifite_pmkid",
             "description": "Wifite PMKID capture",
             "command": "wifite --pmkid -i {iface}"},
            {"name": "deauth_target",
             "description": "Targeted deauth with aireplay-ng",
             "command": "aireplay-ng --deauth {count} -a {bssid} {iface}"},
        ],
        "note": "phase-1c-stub: full cockpit-sourced list lands in phase 1d",
    }


async def _run_attack_profile(args: Dict[str, Any], conn: sqlite3.Connection) -> Dict[str, Any]:
    """Stub: dispatch a named attack profile.

    Phase 1D wires this to either: (a) shared SQLite read of the profile
    template + local subprocess execution, or (b) HTTP-callback to the
    cockpit's RootShell native module for unified exec.
    """
    return {
        "status": "not_implemented",
        "args_received": args,
        "note": "phase-1c-stub: wire to cockpit profile lookup in phase 1d",
    }


# ─── Session handlers — Phase 1C real implementations ─────────────────
# All six delegate to the singleton SessionManager. Errors are coerced to
# structured dicts (rather than raising) so the MCP client always gets a
# parseable JSON payload back, and the audit log records `success: false`.

def _err(e: BaseException) -> Dict[str, Any]:
    return {"error": type(e).__name__, "detail": str(e)}


async def _start_session(args: Dict[str, Any], conn: sqlite3.Connection) -> Dict[str, Any]:
    mgr = get_session_manager()
    try:
        sess = await mgr.start(
            command=str(args["command"]),
            label=str(args.get("label", "")),
            cols=int(args.get("cols", 120)),
            rows=int(args.get("rows", 32)),
        )
    except Exception as e:
        return _err(e)
    return sess.to_dict()


async def _write_stdin(args: Dict[str, Any], conn: sqlite3.Connection) -> Dict[str, Any]:
    mgr = get_session_manager()
    try:
        return await mgr.write(
            sid=str(args["session_id"]),
            data=str(args["data"]),
            newline=bool(args.get("newline", True)),
        )
    except Exception as e:
        return _err(e)


async def _read_session(args: Dict[str, Any], conn: sqlite3.Connection) -> Dict[str, Any]:
    mgr = get_session_manager()
    try:
        return await mgr.read(
            sid=str(args["session_id"]),
            tail_bytes=int(args.get("tail_bytes", 4096)),
            clear=bool(args.get("clear", False)),
        )
    except Exception as e:
        return _err(e)


async def _stop_session(args: Dict[str, Any], conn: sqlite3.Connection) -> Dict[str, Any]:
    mgr = get_session_manager()
    try:
        return await mgr.stop(
            sid=str(args["session_id"]),
            sig_name=str(args.get("signal", "SIGTERM")),
        )
    except Exception as e:
        return _err(e)


async def _list_sessions(args: Dict[str, Any], conn: sqlite3.Connection) -> Dict[str, Any]:
    mgr = get_session_manager()
    try:
        items = await mgr.list_all()
    except Exception as e:
        return _err(e)
    return {"sessions": items, "count": len(items)}


async def _resize_session(args: Dict[str, Any], conn: sqlite3.Connection) -> Dict[str, Any]:
    mgr = get_session_manager()
    try:
        return await mgr.resize(
            sid=str(args["session_id"]),
            cols=int(args["cols"]),
            rows=int(args["rows"]),
        )
    except Exception as e:
        return _err(e)


Handler = Callable[[Dict[str, Any], sqlite3.Connection], Awaitable[Dict[str, Any]]]

INTERNAL_HANDLERS: Dict[str, Handler] = {
    "read_command_logs": _read_command_logs,
    "list_attack_profiles": _list_attack_profiles,
    "run_attack_profile": _run_attack_profile,
    # Phase 1C — real PTY sessions
    "start_session": _start_session,
    "write_stdin": _write_stdin,
    "read_session": _read_session,
    "stop_session": _stop_session,
    "list_sessions": _list_sessions,
    "resize_session": _resize_session,
}
