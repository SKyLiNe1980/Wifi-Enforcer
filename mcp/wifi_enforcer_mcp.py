"""
WiFi Enforcer — MCP Server
==========================

Exposes the WiFi Enforcer FastAPI backend as a set of Model Context Protocol
tools so any MCP-compatible agent (Claude Desktop, Hexstrike-AI, CAI, Hermes,
Cline, Continue, etc.) can drive your rooted Android pentest device by name.

Usage:
    # stdio (Claude Desktop, Continue, Cline):
    python wifi_enforcer_mcp.py

    # SSE/HTTP (Hexstrike-AI server mode, remote agents):
    MCP_TRANSPORT=sse MCP_HOST=0.0.0.0 MCP_PORT=8765 python wifi_enforcer_mcp.py

Environment:
    WIFI_ENFORCER_API   default http://127.0.0.1:8001/api
    AUDIT_LOG_PATH      default /sdcard/wifi_enforcer_mcp_audit.jsonl
                        (falls back to /tmp/... if /sdcard unwritable)
    MCP_TRANSPORT       stdio (default) | sse
    MCP_HOST / MCP_PORT only for sse transport

Audit log:
    Every tool call is appended as one JSON line to AUDIT_LOG_PATH with
    timestamp, tool name, arguments, return status, and elapsed ms. Review
    afterwards with: `jq . < /sdcard/wifi_enforcer_mcp_audit.jsonl`

Safety:
    No allow-list filtering. Agents have the same capability surface as the
    human user of the app. If you want bounded autonomy, edit the GUARDRAILS
    list near the bottom of this file.
"""

from __future__ import annotations

import json
import os
import sys
import time
import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP


# ---------- Configuration ----------
API = os.environ.get("WIFI_ENFORCER_API", "http://127.0.0.1:8001/api").rstrip("/")
DEFAULT_AUDIT = "/sdcard/wifi_enforcer_mcp_audit.jsonl"
FALLBACK_AUDIT = "/tmp/wifi_enforcer_mcp_audit.jsonl"

# Pick the first writable audit log location at startup
def _pick_audit_path() -> str:
    candidate = os.environ.get("AUDIT_LOG_PATH", DEFAULT_AUDIT)
    for path in (candidate, FALLBACK_AUDIT):
        try:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            with open(path, "a"):
                pass
            return path
        except (OSError, PermissionError):
            continue
    return FALLBACK_AUDIT


AUDIT_PATH = _pick_audit_path()


def _audit(tool: str, args: dict, status: str, result: Any, elapsed_ms: int):
    rec = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "tool": tool,
        "args": args,
        "status": status,
        "elapsed_ms": elapsed_ms,
        "result_preview": str(result)[:500] if result is not None else None,
    }
    try:
        with open(AUDIT_PATH, "a") as f:
            f.write(json.dumps(rec) + "\n")
    except Exception as e:
        print(f"[audit] failed to write: {e}", file=sys.stderr)


def _call(method: str, path: str, **kw) -> dict:
    """Synchronous HTTP wrapper around the WiFi Enforcer FastAPI."""
    url = f"{API}{path}"
    started = time.time()
    args_for_audit = {"method": method, "path": path, **{k: v for k, v in kw.items() if k != "json" or len(str(kw.get("json", ""))) < 4000}}
    try:
        with httpx.Client(timeout=120.0) as client:
            r = client.request(method, url, **kw)
            r.raise_for_status()
            data = r.json() if r.text else {}
        _audit(f"http.{method.lower()} {path}", args_for_audit, "ok", data, int((time.time() - started) * 1000))
        return data
    except httpx.HTTPStatusError as e:
        body = e.response.text[:500] if e.response is not None else str(e)
        _audit(f"http.{method.lower()} {path}", args_for_audit, "http_error", body, int((time.time() - started) * 1000))
        raise RuntimeError(f"WiFi Enforcer API {e.response.status_code}: {body}")
    except Exception as e:
        _audit(f"http.{method.lower()} {path}", args_for_audit, "exception", str(e), int((time.time() - started) * 1000))
        raise RuntimeError(f"WiFi Enforcer API call failed: {e}")


# ---------- MCP server ----------
mcp = FastMCP(
    "wifi-enforcer",
    instructions=(
        "Mobile WiFi pentest cockpit running on a rooted Android device with a "
        "custom NetHunter kernel (regulatory lock removed, txpower uncapped). "
        "Use these tools to inspect the radio stack, manage saved attack/defense "
        "profiles, and execute arbitrary commands either directly via Android "
        "root (REAL mode) or inside the Kali NetHunter chroot (KALI mode). "
        "KALI mode is the most useful — gives you the full Kali toolchain. "
        "Before running multi-step operations, call wifi_get_settings() to see "
        "current exec_mode and active interface. Always call wifi_diag() to "
        "establish baseline state before changing regulatory domain or txpower."
    ),
)


# ---------- Read-only / inspection ----------
@mcp.tool()
def wifi_get_settings() -> dict:
    """Return current app settings: exec_mode (mock/real/kali), iface_a/b/c,
    country, active_iface (A/B/C/ALL), and chroot_path. Always call this first
    in a session to understand the operating context."""
    return _call("GET", "/settings")


@mcp.tool()
def wifi_list_profiles() -> list[dict]:
    """List all saved WiFi profiles. Each profile is a named sequence of shell
    commands. Use wifi_run_profile(name) to execute one. Default seeded
    profiles include 'Country Lock: US', 'Reset Regulatory', 'Diagnostics',
    '🩺 Wifi Diag', '🚀 TX Power Max (wlan2)', and '🛑 PANIC'."""
    return _call("GET", "/profiles")


@mcp.tool()
def wifi_list_logs(limit: int = 50) -> list[dict]:
    """Return the most recent shell command executions with stdout, exit code,
    duration, and timestamp. Default 50, max 200. Useful for inspecting the
    output of the last few commands you ran."""
    limit = max(1, min(limit, 200))
    return _call("GET", f"/logs?limit={limit}")


@mcp.tool()
def wifi_diag() -> dict:
    """Capture a comprehensive snapshot of the wireless stack: regulatory
    domain, all PHYs and their per-channel txpower caps, all wireless
    interfaces, current properties, and recent kernel log entries related to
    wifi. Runs the seeded '🩺 Wifi Diag' profile (10 commands). Returns the
    full log batch."""
    profiles = _call("GET", "/profiles")
    diag = next((p for p in profiles if "Wifi Diag" in p["name"] or p["name"] == "Diagnostics"), None)
    if not diag:
        raise RuntimeError("Diag profile not found — backend may be unseeded.")
    return _call("POST", f"/profiles/{diag['id']}/run")


@mcp.tool()
def wifi_get_health() -> dict:
    """Get backend health: root_granted, device model, OS version, exec mocked
    flag. Useful as a quick connectivity & permission probe."""
    return _call("GET", "/health")


# ---------- Action / writes ----------
@mcp.tool()
def wifi_execute(command: str, mode: str = "") -> dict:
    """Execute an arbitrary shell command on the device.

    Args:
        command: the shell command. Simple commands work best (e.g.,
            'iw reg get', 'whoami', 'nmap -sn 192.168.1.0/24'). For commands
            with pipes/redirects/&&, wrap them in 'bash -c "..."' explicitly.
        mode: '' (use current setting — RECOMMENDED), 'mock' (simulated),
            'real' (Android su -c), or 'kali' (NetHunter chroot via
            bootkali custom_cmd). Passing a non-empty value temporarily
            switches mode for THIS call only by updating settings.

    Returns:
        {command, output, exit_code, duration_ms, mocked, timestamp}
        Note: on this MCP server the backend always uses MOCK execution
        unless the backend is running on the actual Android device with the
        native bridge. Check wifi_get_health() to know.
    """
    if mode and mode not in ("mock", "real", "kali"):
        raise ValueError("mode must be one of '', 'mock', 'real', 'kali'")
    if mode:
        # Persist the mode change so the human-facing app reflects it too
        current = _call("GET", "/settings")
        current["exec_mode"] = mode
        _call("PUT", "/settings", json=current)
    return _call("POST", "/execute", json={"command": command})


@mcp.tool()
def wifi_run_profile(name: str) -> dict:
    """Execute a saved profile by name (case-insensitive substring match).

    Args:
        name: profile name or substring (e.g., 'Country Lock', 'TX Power',
            'PANIC', 'Diag').

    Returns:
        {profile_id, profile_name, logs: [...]} — all command outputs.
    """
    profiles = _call("GET", "/profiles")
    needle = name.lower()
    match = next((p for p in profiles if needle in p["name"].lower()), None)
    if not match:
        avail = ", ".join(p["name"] for p in profiles)
        raise RuntimeError(f"No profile matching '{name}'. Available: {avail}")
    return _call("POST", f"/profiles/{match['id']}/run")


@mcp.tool()
def wifi_create_profile(name: str, description: str, commands: list[str]) -> dict:
    """Save a new profile that can later be invoked via wifi_run_profile(name).

    Args:
        name: short unique identifier shown to the user.
        description: one-line summary of what this profile does.
        commands: ordered list of shell commands to execute in sequence.

    Returns:
        the created profile dict {id, name, description, commands, created_at}.
    """
    if not name.strip():
        raise ValueError("name required")
    if not isinstance(commands, list) or not commands:
        raise ValueError("commands must be a non-empty list of strings")
    return _call("POST", "/profiles", json={
        "name": name.strip(),
        "description": description.strip(),
        "commands": [str(c) for c in commands],
    })


@mcp.tool()
def wifi_delete_profile(name: str) -> dict:
    """Delete a saved profile by exact name. Irreversible — does not affect
    the seeded defaults (those will re-appear on backend restart)."""
    profiles = _call("GET", "/profiles")
    match = next((p for p in profiles if p["name"] == name), None)
    if not match:
        raise RuntimeError(f"No profile named exactly '{name}'.")
    return _call("DELETE", f"/profiles/{match['id']}")


@mcp.tool()
def wifi_set_iface_context(
    iface_a: str = "",
    iface_b: str = "",
    iface_c: str = "",
    active: str = "",
) -> dict:
    """Configure which Wi-Fi interfaces are addressable and which one(s) are
    currently active for quick-action commands.

    Args:
        iface_a: primary interface (default 'wlan2' = AWUS036NH). Pass empty
            string to leave unchanged.
        iface_b: optional second adapter (e.g. 'wlan3').
        iface_c: optional third adapter.
        active: 'A', 'B', 'C', or 'ALL'. ALL fans commands out across every
            non-empty iface.

    Returns:
        the updated settings doc.
    """
    s = _call("GET", "/settings")
    if iface_a: s["iface_a"] = iface_a
    if iface_b is not None: s["iface_b"] = iface_b
    if iface_c is not None: s["iface_c"] = iface_c
    if active:
        if active not in ("A", "B", "C", "ALL"):
            raise ValueError("active must be A, B, C, or ALL")
        s["active_iface"] = active
    return _call("PUT", "/settings", json=s)


@mcp.tool()
def wifi_set_exec_mode(mode: str) -> dict:
    """Persistently switch execution mode for all subsequent commands.

    Args:
        mode: 'mock' (preview/dry-run), 'real' (Android root via su -c),
            'kali' (NetHunter chroot via bootkali custom_cmd).

    Returns:
        the updated settings doc.
    """
    if mode not in ("mock", "real", "kali"):
        raise ValueError("mode must be one of: mock, real, kali")
    s = _call("GET", "/settings")
    s["exec_mode"] = mode
    return _call("PUT", "/settings", json=s)


@mcp.tool()
def wifi_set_country(code: str) -> dict:
    """Shortcut to set the regulatory domain via `iw reg set <CC>`. The
    custom NetHunter kernel on this device has the userspace regdomain lock
    removed, so this actually takes effect (unlike on stock Samsung).

    Args:
        code: ISO-3166 two-letter country code, uppercase (e.g., 'KE', 'US',
            'GY', 'BO'). Use 'KE' for permissive 2.4GHz/5GHz with 30dBm cap.

    Returns:
        execution log of the `iw reg set` command.
    """
    code = code.strip().upper()
    if len(code) != 2 or not code.isalpha():
        raise ValueError("country code must be 2 letters, e.g. 'KE'")
    s = _call("GET", "/settings")
    s["country"] = code
    _call("PUT", "/settings", json=s)
    return _call("POST", "/execute", json={"command": f"iw reg set {code}"})


@mcp.tool()
def wifi_panic() -> dict:
    """🛑 EMERGENCY STOP — runs the PANIC profile that disables radio mayhem.

    Sequence: kill any running Kali processes, disable forced country code,
    bring monitor-mode interfaces down, re-enable normal Android WiFi.

    Use this if an attack script ran amok or you need to quickly become
    invisible. Returns the log of all commands run.
    """
    return wifi_run_profile("PANIC")


@mcp.tool()
def wifi_clear_logs() -> dict:
    """Wipe the terminal/command log buffer. Does NOT touch the MCP audit
    log (that one is append-only on disk). Useful for keeping the human
    terminal view tidy after a verbose agent session."""
    return _call("DELETE", "/logs")


@mcp.tool()
def wifi_get_audit_log(lines: int = 100) -> list[dict]:
    """Return recent entries from the MCP audit log — every tool call this
    server has handled, with timestamps and outcomes. Useful for agents to
    introspect their own recent activity, and for the human to review what
    the swarm did. Lives at AUDIT_LOG_PATH."""
    lines = max(1, min(lines, 1000))
    try:
        with open(AUDIT_PATH) as f:
            all_lines = f.readlines()
        recent = all_lines[-lines:]
        return [json.loads(l) for l in recent if l.strip()]
    except FileNotFoundError:
        return []


# ============================================================
# Streaming Sessions — for long-running tools (airodump, wifite, tcpdump)
# ============================================================
# The actual tool exec happens on the rooted Android device via the app's
# native bridge. The app pushes line batches to the backend in near real-time
# so this MCP server can expose them to LLM agents.

@mcp.tool()
def wifi_stream_start(command: str, iface: str = "", label: str = "") -> dict:
    """🛰️ Start a STREAMING shell session for long-running tools that produce
    continuous output (airodump-ng, wifite, tcpdump, hcxdumptool, dmesg -w, etc).
    Unlike wifi_execute() which blocks, this returns immediately with a
    session_id. Poll output with wifi_stream_tail(session_id, since=cursor).

    NOTE: The session is only actually launched when the human-facing app is
    open AND in REAL/KALI exec mode. This tool registers the session record
    with the backend but does NOT itself spawn a process — the app's Live tab
    polls this server and picks up new sessions to execute. (For autonomous
    agent control without the app, run commands via wifi_execute and accept
    the blocking behavior.)

    Args:
        command: full shell command, e.g. 'airodump-ng wlan2'.
        iface:   optional interface tag for grouping in the UI.
        label:   short human-readable label (defaults to the first word).

    Returns:
        {id, command, iface, label, started_at, status: 'running', ...}
    """
    if not command.strip():
        raise ValueError("command required")
    payload = {"command": command, "iface": iface, "label": label}
    return _call("POST", "/sessions/start", json=payload)


@mcp.tool()
def wifi_stream_list(include_ended: bool = False) -> list[dict]:
    """List active streaming sessions on the device.

    Args:
        include_ended: also include sessions that exited but haven't been
            removed yet (default False — running only).

    Returns:
        list of {id, command, iface, label, started_at, pid, status,
                 exit_code, duration_ms, line_count, mocked}.
    """
    return _call("GET", f"/sessions?include_ended={'true' if include_ended else 'false'}")


@mcp.tool()
def wifi_stream_tail(session_id: str, since: int = 0, max_lines: int = 500) -> dict:
    """Fetch new output lines from a streaming session.

    Args:
        session_id: the id returned by wifi_stream_start or seen in
            wifi_stream_list.
        since: cursor (line_no) of the last line you've seen. Pass 0 to start
            from the top of the ring buffer. Use the returned 'cursor' value
            as 'since' on the next call to incrementally tail.
        max_lines: cap on lines returned this call (default 500, max 500).

    Returns:
        {id, status, line_count, cursor, lines: [{stream, line, line_no, ts}, ...]}
        — `cursor` is the new high-water mark to pass back as `since` next time.
    """
    max_lines = max(1, min(max_lines, 500))
    return _call("GET", f"/sessions/{session_id}/tail?since={int(since)}&max_lines={max_lines}")


@mcp.tool()
def wifi_stream_grep(session_id: str, pattern: str, since: int = 0, max_lines: int = 500) -> dict:
    """Tail a session AND filter lines client-side by a substring/regex.
    Useful for catching WPA handshakes in airodump output, PMKID hashes from
    hcxdumptool, EAPOL events from tcpdump, etc.

    Args:
        session_id, since, max_lines: same as wifi_stream_tail.
        pattern: case-insensitive substring OR a Python regex (auto-detected
            if it contains regex metachars).

    Returns:
        {id, status, cursor, matched_count, lines: [...filtered]}
    """
    import re as _re
    raw = _call("GET", f"/sessions/{session_id}/tail?since={int(since)}&max_lines={int(max_lines)}")
    metachars = set(".+*?[]{}()|\\^$")
    if any(c in pattern for c in metachars):
        try:
            rx = _re.compile(pattern, _re.IGNORECASE)
            matched = [l for l in raw.get("lines", []) if rx.search(l.get("line", ""))]
        except _re.error:
            needle = pattern.lower()
            matched = [l for l in raw.get("lines", []) if needle in l.get("line", "").lower()]
    else:
        needle = pattern.lower()
        matched = [l for l in raw.get("lines", []) if needle in l.get("line", "").lower()]
    return {
        "id": raw.get("id", session_id),
        "status": raw.get("status"),
        "cursor": raw.get("cursor", since),
        "matched_count": len(matched),
        "lines": matched,
    }


@mcp.tool()
def wifi_stream_stop(session_id: str, graceful: bool = True) -> dict:
    """Mark a streaming session for termination. The app's Live tab observes
    this and issues SIGINT (graceful=True, lets airodump/tcpdump flush their
    capture files) or SIGKILL (graceful=False, immediate) on the next poll.

    Args:
        session_id: target session.
        graceful: True (recommended for capture tools) sends SIGINT then
            escalates to SIGKILL after 2s; False sends SIGKILL immediately.

    Returns:
        {ok: true, session_id, requested: 'SIGINT'|'SIGKILL'}
        NOTE: actual stop happens on-device — confirm via wifi_stream_list().
    """
    # Backend doesn't yet have a direct "kill" endpoint that signals the app
    # (the app polls /sessions and runs killSession() locally). For now we
    # mark the session with status=killing in its end record by appending
    # a control line that the app interprets. Simplest: just call /end with
    # status='killed' and let the app's onExit handler clean up.
    # For graceful, we rely on the app to actually deliver SIGINT.
    payload = {"exit_code": -1, "duration_ms": 0, "status": "killing" if graceful else "kill_force"}
    _call("POST", f"/sessions/{session_id}/end", json=payload)
    return {"ok": True, "session_id": session_id, "requested": "SIGINT" if graceful else "SIGKILL"}


@mcp.tool()
def wifi_stream_history(limit: int = 20) -> list[dict]:
    """Persisted session summaries from MongoDB (ended sessions with their
    last ~500 lines of output). Useful for retrospectively analyzing a recon
    run after it completed.

    Args:
        limit: how many most-recent sessions to return (default 20, max 500).
    """
    limit = max(1, min(limit, 500))
    return _call("GET", f"/sessions/history?limit={limit}")


# ---------- Entry point ----------
def main():
    transport = os.environ.get("MCP_TRANSPORT", "stdio").lower()
    print(f"[wifi-enforcer-mcp] api={API} audit={AUDIT_PATH} transport={transport}", file=sys.stderr)

    if transport == "stdio":
        mcp.run()
    elif transport in ("sse", "http", "streamable-http"):
        host = os.environ.get("MCP_HOST", "127.0.0.1")
        port = int(os.environ.get("MCP_PORT", "8765"))
        print(f"[wifi-enforcer-mcp] listening on {host}:{port} ({transport})", file=sys.stderr)
        # FastMCP supports both 'sse' and 'streamable-http' as transports
        try:
            mcp.run(transport=transport, host=host, port=port)
        except TypeError:
            # older FastMCP versions don't accept host/port kwargs
            os.environ.setdefault("FASTMCP_HOST", host)
            os.environ.setdefault("FASTMCP_PORT", str(port))
            mcp.run(transport=transport)
    else:
        raise SystemExit(f"unknown MCP_TRANSPORT: {transport!r} (use 'stdio' or 'sse')")


if __name__ == "__main__":
    main()
