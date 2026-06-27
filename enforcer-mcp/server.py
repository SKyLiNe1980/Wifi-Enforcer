#!/usr/bin/env python3
"""
Enforcer-MCP — Streamable-HTTP Model Context Protocol server.

Runs inside the Kali NetHunter chroot on the cockpit device (and, later, on
arm64 swarm nodes via the `enforcer-node` .deb). Exposes the cockpit's root
primitives (shell exec, iface mgmt, attack profiles, PTY sessions) as MCP
tools that LLM agents (Hermes, Claude, etc.) can drive.

Key contracts:
  • Transport: Streamable HTTP (MCP 2025-03-26 spec) at /mcp
  • Auth:      Authorization: Bearer <hex token from config.yaml>
  • Aux:       GET /health, GET /audit/since?ts=ISO8601
  • Lifecycle: foreground process, JSON logs to stdout, SIGTERM-clean
  • Tools:     Dynamic, loaded from config.yaml at startup. External
               (subprocess.run) or internal (__internal:* → Python handler).

Run:
    python3 server.py --config /etc/enforcer-mcp/config.yaml
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shlex
import signal
import sqlite3
import subprocess
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from jsonschema import Draft202012Validator
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

# FastMCP 3.x — gofastmcp.com. v1.x got merged into the MCP Python SDK in 2024;
# we want the standalone successor that the ecosystem actively maintains.
from fastmcp import FastMCP

from handlers import INTERNAL_HANDLERS, init_session_manager, get_session_manager


# ─── Structured logging ────────────────────────────────────────────────────
def log(level: str, msg: str, **fields: Any) -> None:
    """Emit a single-line JSON log to stdout. Cheap, structured, parseable."""
    record = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "msg": msg,
        **fields,
    }
    print(json.dumps(record, default=str), flush=True)


# ─── SQLite audit storage ──────────────────────────────────────────────────
AUDIT_MAX_DEFAULT = 2000


def init_audit_db(db_path: str) -> sqlite3.Connection:
    """Open (or create) the audit DB. Uses WAL so the cockpit can read it
    concurrently from a sibling process if we later go that route."""
    conn = sqlite3.connect(db_path, check_same_thread=False, isolation_level=None)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS audit_log (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            ts           TEXT    NOT NULL,
            tool_name    TEXT    NOT NULL,
            args_json    TEXT    NOT NULL DEFAULT '{}',
            result_summary TEXT  NOT NULL DEFAULT '',
            client_id    TEXT             DEFAULT '',
            duration_ms  INTEGER NOT NULL DEFAULT 0,
            exit_code    INTEGER NOT NULL DEFAULT 0,
            success      INTEGER NOT NULL DEFAULT 1
        )"""
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit_log(tool_name)")
    return conn


def audit_append(
    conn: sqlite3.Connection,
    tool_name: str,
    args: Dict[str, Any],
    result_summary: str,
    duration_ms: int,
    exit_code: int,
    success: bool,
    client_id: str = "",
    cap: int = AUDIT_MAX_DEFAULT,
) -> None:
    """Insert one row + trim to most-recent N. Cap default = 2000."""
    conn.execute(
        """INSERT INTO audit_log
           (ts, tool_name, args_json, result_summary, client_id,
            duration_ms, exit_code, success)
           VALUES (?,?,?,?,?,?,?,?)""",
        (
            datetime.now(timezone.utc).isoformat(),
            tool_name,
            json.dumps(args),
            result_summary[:512],  # keep summaries lean
            client_id,
            duration_ms,
            exit_code,
            1 if success else 0,
        ),
    )
    # Drop everything older than the cap. Cheap because id is autoincrement.
    conn.execute(
        """DELETE FROM audit_log WHERE id NOT IN (
             SELECT id FROM audit_log ORDER BY id DESC LIMIT ?
           )""",
        (cap,),
    )


# ─── Bearer-token middleware ───────────────────────────────────────────────
class BearerAuthMiddleware(BaseHTTPMiddleware):
    """Validates `Authorization: Bearer <hex>`.

    Bypassed for:
      • OPTIONS (CORS preflight)
      • /health (always public — used by load balancers and the cockpit's
        first-touch probe BEFORE the token is configured)
    """

    def __init__(self, app, token_hex: str, require_token: bool):
        super().__init__(app)
        self.expected = (token_hex or "").lower().strip()
        self.require = require_token and bool(self.expected)

    async def dispatch(self, request: Request, call_next):
        if request.method == "OPTIONS" or request.url.path == "/health":
            return await call_next(request)
        if not self.require:
            return await call_next(request)
        auth = request.headers.get("authorization", "")
        if not auth.lower().startswith("bearer "):
            return JSONResponse(
                {"error": "missing bearer token"},
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )
        token = auth[7:].strip().lower()
        if token != self.expected:
            return JSONResponse({"error": "invalid bearer token"}, status_code=403)
        return await call_next(request)


# ─── Tool registration ─────────────────────────────────────────────────────
class ToolSpec:
    """Concrete tool definition loaded from config.yaml."""

    __slots__ = ("name", "description", "command_template", "schema",
                 "wrap_mode", "timeout_sec", "is_internal")

    def __init__(self, raw: Dict[str, Any]):
        self.name = raw["name"]
        self.description = raw.get("description", "")
        self.command_template = raw["command_template"]
        # arg_schema_json may be a string (yaml `|` block) or already-parsed dict
        sch = raw.get("arg_schema_json", "{}")
        self.schema = json.loads(sch) if isinstance(sch, str) else sch
        self.wrap_mode = raw.get("wrap_mode", "none")
        self.timeout_sec = int(raw.get("timeout_sec", 60))
        self.is_internal = self.command_template.startswith("__internal:")
        # Validate the schema itself so a typo crashes startup, not a request
        Draft202012Validator.check_schema(self.schema)


def _summarize(s: str, n: int = 400) -> str:
    """Audit summaries are stored truncated; full output stays in the
    tool response that the MCP client receives."""
    s = (s or "").strip()
    return (s[:n] + "…") if len(s) > n else s


async def _exec_external(spec: ToolSpec, args: Dict[str, Any]) -> Dict[str, Any]:
    """Run a `command_template` filled with args via subprocess.run.

    Substitution is regex-based, NOT Python's str.format. Reason: command
    templates frequently contain shell braces that are NOT placeholders —
    awk `{print}`, sed `{...}`, JSON `{}`, etc. `str.format` would explode
    on those. Our regex only replaces `{name}` when `name` is a key in the
    args dict (validated against the JSON Schema earlier). Everything else
    passes through to the shell verbatim.

    Returns dict with output / exit_code / success / timed_out.
    """
    def _sub(match: "re.Match[str]") -> str:
        key = match.group(1)
        if key in args:
            return str(args[key])
        # Unknown key → leave the literal `{name}` in place. Schema
        # validation already caught missing-required cases upstream; this
        # branch protects shell idioms like `awk '{print $1}'`.
        return match.group(0)

    cmd_str = re.sub(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}", _sub, spec.command_template)

    # Run via `bash -c "<cmd>"` so pipelines, redirects, globs, and shell
    # idioms (`awk '{print}'`, `iw dev | grep wlan`, etc.) all just work.
    # shlex.split + argv-style exec would fail on `|`. Trade-off: callers
    # must trust the *server config* (these templates), since args ARE
    # validated by JSON Schema but the template itself is operator-supplied.
    cmd_list = ["bash", "-c", cmd_str]

    log("info", "exec.external", tool=spec.name, cmd=cmd_str, timeout=spec.timeout_sec)
    try:
        completed = await asyncio.to_thread(
            subprocess.run,
            cmd_list,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,  # merge so LLM sees full picture
            text=True,
            timeout=spec.timeout_sec,
        )
        return {
            "output": completed.stdout,
            "exit_code": completed.returncode,
            "success": completed.returncode == 0,
            "timed_out": False,
        }
    except subprocess.TimeoutExpired as e:
        return {
            "output": (e.stdout or "") + f"\n[timeout after {spec.timeout_sec}s]",
            "exit_code": -1,
            "success": False,
            "timed_out": True,
        }
    except FileNotFoundError as e:
        return {
            "output": f"[command not found] {e}",
            "exit_code": 127,
            "success": False,
            "timed_out": False,
        }


async def _exec_internal(
    spec: ToolSpec, args: Dict[str, Any], conn: sqlite3.Connection,
) -> Dict[str, Any]:
    """Dispatch to a Python handler from handlers.INTERNAL_HANDLERS."""
    directive = spec.command_template[len("__internal:"):]
    handler = INTERNAL_HANDLERS.get(directive)
    if handler is None:
        return {
            "output": json.dumps({"error": f"unknown internal handler: {directive}"}),
            "exit_code": 127,
            "success": False,
            "timed_out": False,
        }
    try:
        result = await asyncio.wait_for(handler(args, conn), timeout=spec.timeout_sec)
        return {
            "output": json.dumps(result, default=str),
            "exit_code": 0,
            "success": True,
            "timed_out": False,
        }
    except asyncio.TimeoutError:
        return {"output": "[internal timeout]", "exit_code": -1,
                "success": False, "timed_out": True}
    except Exception as e:
        log("error", "internal.handler.exception", tool=spec.name, err=str(e))
        return {"output": f"[handler error] {e}", "exit_code": -1,
                "success": False, "timed_out": False}


def register_tools(
    mcp: FastMCP, specs: List[ToolSpec], conn: sqlite3.Connection,
) -> None:
    """Programmatically register each tool with FastMCP.

    FastMCP normally introspects type hints for schema generation. Since our
    schemas come from YAML, we expose each tool as accepting a single
    `args: dict` and do our own jsonschema validation inside the handler.
    The tool description embeds the full JSON Schema so MCP clients can
    still see what shape `args` should take.
    """
    for spec in specs:
        validator = Draft202012Validator(spec.schema)

        # Bind spec/validator via a factory function so FastMCP's pydantic
        # schema introspection doesn't see them as user-facing defaults
        # (which spawned a flood of "non-serializable default" warnings).
        def _make_handler(_spec: ToolSpec, _v: Draft202012Validator):
            async def _tool_impl(args: Dict[str, Any]) -> Dict[str, Any]:
                t0 = datetime.now(timezone.utc)
                # Smooth two calling conventions:
                #   • {"args": {"file": "..."}}   (matches our wrapper schema)
                #   • {"file": "..."}             (direct — what most clients try first)
                # FastMCP introspects our handler signature as accepting a single
                # `args: dict` param, so the auto-generated schema technically wants
                # the wrapper form. But Postman / Hermes / curl users instinctively
                # send the inner shape. Unwrap if we see the wrapper, otherwise treat
                # args as the inner dict directly.
                if isinstance(args, dict) and "args" in args and len(args) == 1 \
                        and isinstance(args["args"], dict):
                    args = args["args"]
                # Validate args against the YAML-defined schema
                errors = sorted(_v.iter_errors(args), key=lambda e: list(e.path))
                if errors:
                    msg = "; ".join(e.message for e in errors)
                    log("warn", "validation.fail", tool=_spec.name, err=msg)
                    result = {
                        "output": json.dumps({"error": "invalid args", "detail": msg}),
                        "exit_code": 2, "success": False, "timed_out": False,
                    }
                elif _spec.is_internal:
                    result = await _exec_internal(_spec, args, conn)
                else:
                    result = await _exec_external(_spec, args)

                duration_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
                audit_append(
                    conn,
                    tool_name=_spec.name,
                    args=args,
                    result_summary=_summarize(result.get("output", "")),
                    duration_ms=duration_ms,
                    exit_code=int(result.get("exit_code", 0)),
                    success=bool(result.get("success", False)),
                )
                result["duration_ms"] = duration_ms
                return result
            return _tool_impl

        _tool_impl = _make_handler(spec, validator)

        # Embed the YAML schema directly into the description so MCP clients
        # see what `args` should look like even though the wrapper signature
        # is just a single dict param.
        desc = f"{spec.description}\n\nargs schema:\n{json.dumps(spec.schema, indent=2)}"

        # FastMCP supports decorator-style registration. Calling .tool() with
        # name+description AS a function (vs @ decorator) registers at runtime.
        mcp.tool(name=spec.name, description=desc)(_tool_impl)
        log("info", "tool.registered", name=spec.name, internal=spec.is_internal)


# ─── App composition ───────────────────────────────────────────────────────
def build_app(cfg: Dict[str, Any], conn: sqlite3.Connection) -> FastAPI:
    server_cfg = cfg.get("server", {})
    bearer = server_cfg.get("bearer_token_hex", "")
    require_token = bool(server_cfg.get("require_token", True))
    mcp_path = server_cfg.get("mcp_path", "/mcp")
    allowed_origins = server_cfg.get("allowed_origins", []) or []

    # Build the FastMCP server + register tools from config
    mcp = FastMCP("enforcer-mcp")
    specs = [ToolSpec(t) for t in cfg.get("tools", [])]
    register_tools(mcp, specs, conn)

    # FastMCP 3.x exposes `http_app()` which returns a Streamable-HTTP ASGI
    # app. Older 2.x called it `streamable_http_app()`. Be tolerant of both
    # in case the chroot has a slightly older pin.
    if hasattr(mcp, "http_app"):
        mcp_asgi = mcp.http_app(path="/")  # mounted at /mcp by FastAPI
    elif hasattr(mcp, "streamable_http_app"):
        mcp_asgi = mcp.streamable_http_app(path="/")
    else:
        raise RuntimeError(
            "FastMCP build does not expose http_app() or streamable_http_app(). "
            "Upgrade with: pip install -U 'fastmcp>=3.4'"
        )

    # Initialise the PTY-backed session manager (Phase 1C). We do this here
    # — inside the lifespan startup phase — so the asyncio event loop exists
    # before any session's loop.add_reader is wired up. Default cap is 16
    # sessions × 64 KiB ring each (~1 MiB worst case). Knobs live under
    # `sessions:` in config.yaml.
    sessions_cfg = cfg.get("sessions", {}) or {}
    session_ring_cap = int(sessions_cfg.get("ring_cap_bytes", 64 * 1024))
    session_max = int(sessions_cfg.get("max_sessions", 16))

    # FastAPI hosts both the MCP endpoint AND our auxiliary HTTP routes.
    # The MCP ASGI app supplies a lifespan we must wire into FastAPI so
    # the MCP server's background tasks start/stop cleanly.
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Sessions singleton must be initialised inside the running loop
        # so loop.add_reader / asyncio.Lock pick up the right one.
        init_session_manager(
            ring_cap=session_ring_cap,
            max_sessions=session_max,
            logger=log,
        )
        async with mcp_asgi.lifespan(app):
            log("info", "server.startup", tools=len(specs),
                bind=server_cfg.get("host"), port=server_cfg.get("port"),
                session_ring_cap=session_ring_cap,
                session_max=session_max)
            try:
                yield
            finally:
                log("info", "server.shutdown")
                # Tear down any live PTY sessions before closing the DB so
                # their final-drain reads can still hit a valid event loop.
                try:
                    await get_session_manager().shutdown_all()
                except Exception as e:
                    log("warn", "sessions.shutdown.error", err=str(e))
                conn.close()

    app = FastAPI(
        title="enforcer-mcp",
        version="0.1.0-phase-1b",
        lifespan=lifespan,
    )

    if allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=allowed_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    app.add_middleware(BearerAuthMiddleware, token_hex=bearer, require_token=require_token)

    @app.get("/health")
    async def health():
        # Intentionally bypasses auth (see middleware) so the cockpit can
        # probe whether the server is up BEFORE pasting the token in.
        return {
            "status": "ok",
            "service": "enforcer-mcp",
            "version": "0.1.0-phase-1b",
            "tools": len(specs),
            "require_token": require_token,
            "ts": datetime.now(timezone.utc).isoformat(),
        }

    @app.get("/audit/since")
    async def audit_since(ts: Optional[str] = None, limit: int = 200):
        limit = max(1, min(limit, 500))
        if ts:
            rows = conn.execute(
                """SELECT id, ts, tool_name, args_json, result_summary, client_id,
                          duration_ms, exit_code, success
                   FROM audit_log WHERE ts > ? ORDER BY ts ASC LIMIT ?""",
                (ts, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT id, ts, tool_name, args_json, result_summary, client_id,
                          duration_ms, exit_code, success
                   FROM audit_log ORDER BY ts DESC LIMIT ?""",
                (limit,),
            ).fetchall()
            rows.reverse()  # oldest-first for streaming UX
        events = [
            {
                "id": r[0], "ts": r[1], "tool_name": r[2],
                "args": json.loads(r[3] or "{}"),
                "result_summary": r[4], "client_id": r[5],
                "duration_ms": r[6], "exit_code": r[7], "success": bool(r[8]),
            }
            for r in rows
        ]
        return {"events": events, "count": len(events)}

    @app.get("/tools")
    async def tools_meta():
        """Convenience JSON listing of registered tools.

        MCP-aware clients should use the MCP `tools/list` method instead;
        this endpoint exists so the cockpit's // tools tab can verify what
        the SERVER thinks it's got registered (vs what's just in local SQLite).
        """
        return {
            "tools": [
                {
                    "name": s.name,
                    "description": s.description,
                    "wrap_mode": s.wrap_mode,
                    "timeout_sec": s.timeout_sec,
                    "internal": s.is_internal,
                    "command_template": s.command_template,
                    "arg_schema": s.schema,
                }
                for s in specs
            ]
        }

    # Mount the MCP ASGI app at /mcp. Streamable-HTTP clients POST/GET there.
    app.mount(mcp_path, mcp_asgi)

    return app


def load_config(path: str) -> Dict[str, Any]:
    if not os.path.isfile(path):
        raise SystemExit(f"config file not found: {path}")
    with open(path, "r", encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh)
    if not isinstance(cfg, dict):
        raise SystemExit("config.yaml must be a YAML mapping")
    return cfg


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="enforcer-mcp")
    parser.add_argument("--config", "-c", required=True, help="Path to config.yaml")
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    server_cfg = cfg.get("server", {})
    host = server_cfg.get("host", "127.0.0.1")
    port = int(server_cfg.get("port", 8765))

    # Audit DB lives next to the config (writable by the enforcer user).
    db_path = os.path.join(os.path.dirname(os.path.abspath(args.config)), "audit.db")
    conn = init_audit_db(db_path)
    log("info", "audit.db.opened", path=db_path)

    app = build_app(cfg, conn)

    # Graceful shutdown
    import uvicorn

    config = uvicorn.Config(
        app, host=host, port=port,
        log_level="warning",  # FastMCP & our log() handle structured logging
        access_log=False,
    )
    server = uvicorn.Server(config)

    def _sigterm(*_):
        log("info", "signal.sigterm")
        server.should_exit = True

    signal.signal(signal.SIGTERM, _sigterm)
    signal.signal(signal.SIGINT, _sigterm)

    try:
        server.run()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
