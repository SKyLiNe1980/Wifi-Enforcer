"""
In-process handlers for tools whose command_template = '__internal:<name>'.

These are dispatched directly by the server without shell-out, so they're
fast, side-effect-free w.r.t. the OS, and can talk to the audit DB / future
session registry safely. Each handler is async and takes (args, conn) where
`conn` is the server's sqlite3 connection to the audit DB.

Phase 1B stubs many handlers (sessions / attack-profiles / pcap) — they
return a friendly 'not implemented yet' payload. Phase 1C+ will wire them
to the cockpit's own SQLite via shared file path (the chroot can read the
Android app's enforcer.db once mount permissions are arranged) OR via a
cockpit-exposed loopback HTTP callback.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any, Awaitable, Callable, Dict, List


async def _read_command_logs(args: Dict[str, Any], conn: sqlite3.Connection) -> Dict[str, Any]:
    """Return recent rows from the MCP server's OWN audit log.

    NOTE: This is the *server-side* audit (every tool call routed through MCP).
    Phase 1C will add a separate handler that reads the *cockpit's* SQLite
    command_logs table (the phone app's terminal history) once we agree on a
    file path / IPC scheme.
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

    In Phase 1C this will read from the cockpit's attack_profiles table
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
        "note": "phase-1b-stub: full cockpit-sourced list lands in phase 1c",
    }


async def _run_attack_profile(args: Dict[str, Any], conn: sqlite3.Connection) -> Dict[str, Any]:
    """Stub: dispatch a named attack profile.

    Phase 1C wires this to either: (a) shared SQLite read of the profile
    template + local subprocess execution, or (b) HTTP-callback to the
    cockpit's RootShell native module for unified exec.
    """
    return {
        "status": "not_implemented",
        "args_received": args,
        "note": "phase-1b-stub: wire to subprocess in phase 1c",
    }


# ─── Session registry stubs ───────────────────────────────────────────
# Phase 1C: full long-lived PTY tracking using asyncio.subprocess + ring
# buffers. Phase 1B exposes the API surface so clients can already wire
# their flows against it.

_SESSIONS: Dict[str, Dict[str, Any]] = {}


async def _start_session(args: Dict[str, Any], conn: sqlite3.Connection) -> Dict[str, Any]:
    return {
        "status": "not_implemented",
        "would_run": args.get("command"),
        "label": args.get("label"),
        "note": "phase-1b-stub: pty.spawn-backed sessions land in phase 1c",
    }


async def _write_stdin(args: Dict[str, Any], conn: sqlite3.Connection) -> Dict[str, Any]:
    return {"status": "not_implemented", "session_id": args.get("session_id")}


async def _read_session(args: Dict[str, Any], conn: sqlite3.Connection) -> Dict[str, Any]:
    return {"status": "not_implemented", "session_id": args.get("session_id"), "bytes": ""}


async def _stop_session(args: Dict[str, Any], conn: sqlite3.Connection) -> Dict[str, Any]:
    return {"status": "not_implemented", "session_id": args.get("session_id")}


Handler = Callable[[Dict[str, Any], sqlite3.Connection], Awaitable[Dict[str, Any]]]

INTERNAL_HANDLERS: Dict[str, Handler] = {
    "read_command_logs": _read_command_logs,
    "list_attack_profiles": _list_attack_profiles,
    "run_attack_profile": _run_attack_profile,
    "start_session": _start_session,
    "write_stdin": _write_stdin,
    "read_session": _read_session,
    "stop_session": _stop_session,
}
