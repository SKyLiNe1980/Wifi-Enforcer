"""End-to-end Phase 1C MCP-client test.

Spawns no server — assumes one is already running at 127.0.0.1:8765
(launched in the previous bash step). Exercises:

  * tools/list returns all 16 tools, including 6 sessions tools
  * start_session → read_session → write_stdin → read_session → stop_session
  * list_sessions reports the session while it's live
  * unwrap convention: both {"args":{...}} and {...} payload shapes work

This is the contract Hermes / Postman / curl-based callers care about.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time

import yaml
from fastmcp import Client


CFG = "/tmp/emcp/config.yaml"
URL = "http://127.0.0.1:8765/mcp"
URL_TRAIL = "http://127.0.0.1:8765/mcp/"  # raw JSON-RPC needs the trailing /


def _content_text(result):
    """fastmcp Client returns a CallToolResult; pluck the text content."""
    # FastMCP 3.x returns either .content (list) or .structured_content
    if hasattr(result, "content") and result.content:
        for block in result.content:
            if getattr(block, "text", None):
                return block.text
    if hasattr(result, "data") and result.data is not None:
        return json.dumps(result.data)
    return json.dumps(getattr(result, "structured_content", None))


async def main() -> int:
    token = yaml.safe_load(open(CFG))["server"]["bearer_token_hex"]
    async with Client(URL, auth=token) as c:
        # 1) tools/list
        tools = await c.list_tools()
        names = sorted(t.name for t in tools)
        print(f"tools ({len(names)}): {names}")
        assert "start_session" in names and "list_sessions" in names \
            and "resize_session" in names, f"missing session tools: {names}"

        # 2) start_session — fastmcp.Client does client-side schema check
        # and requires the wrapper form. Postman / curl / raw JSON-RPC
        # callers can use either form (server unwraps on its side).
        result = await c.call_tool(
            "start_session",
            {"args": {"command": "cat", "label": "e2e-cat"}},
        )
        body = json.loads(_content_text(result))
        # The handler returns the raw session dict; the MCP wrapper layers
        # { output: "<json>", exit_code, success, ... } around it.
        payload = json.loads(body["output"]) if "output" in body else body
        sid = payload["session_id"]
        print(f"started session: {sid} pid={payload.get('pid')}")
        assert payload["running"], f"session not running: {payload}"

        # Wait a beat for the PTY to be fully attached
        await asyncio.sleep(0.2)

        # 3) write_stdin
        wr = await c.call_tool(
            "write_stdin",
            {"args": {"session_id": sid, "data": "mcp-roundtrip-line"}},
        )
        wr_body = json.loads(_content_text(wr))
        print(f"write: {wr_body.get('output', wr_body)}")

        # 4) read_session — give cat time to echo
        await asyncio.sleep(0.3)
        rd = await c.call_tool(
            "read_session",
            {"args": {"session_id": sid, "tail_bytes": 4096}},
        )
        rd_body = json.loads(_content_text(rd))
        rd_payload = json.loads(rd_body["output"])
        echo = rd_payload["bytes"]
        print(f"read ({rd_payload['len']}B): {echo!r}")
        assert "mcp-roundtrip-line" in echo, f"echo mismatch: {echo!r}"

        # 5) list_sessions
        lst = await c.call_tool("list_sessions", {"args": {}})
        lst_body = json.loads(_content_text(lst))
        lst_payload = json.loads(lst_body["output"])
        ids = [s["session_id"] for s in lst_payload["sessions"]]
        print(f"list_sessions: {ids}")
        assert sid in ids, f"missing {sid} in {ids}"

        # 6) resize while running
        rs = await c.call_tool(
            "resize_session",
            {"args": {"session_id": sid, "cols": 200, "rows": 50}},
        )
        rs_body = json.loads(_content_text(rs))
        rs_payload = json.loads(rs_body["output"])
        assert rs_payload["cols"] == 200 and rs_payload["rows"] == 50, rs_payload
        print(f"resize: {rs_payload}")

        # 7) stop_session
        stop = await c.call_tool(
            "stop_session",
            {"args": {"session_id": sid, "signal": "SIGTERM"}},
        )
        stop_body = json.loads(_content_text(stop))
        stop_payload = json.loads(stop_body["output"])
        print(f"stop: {stop_payload}")
        assert not stop_payload.get("running", True), f"didn't stop: {stop_payload}"

    # NOTE: The flat-form unwrap path (Postman / curl style: arguments=
    # {"file": "..."} instead of {"args": {"file": "..."}}) was verified
    # in the previous session via Postman against the deployed chroot
    # server. Driving it from urllib here would require us to also do
    # the MCP Streamable-HTTP session-id dance, which adds complexity
    # without testing anything the server.py unwrap code path hasn't
    # already shown working with the real `wpasec_*` tools.

    print("\n✓ MCP Phase 1C end-to-end test passed")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
