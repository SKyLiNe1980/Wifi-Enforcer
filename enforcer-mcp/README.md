# enforcer-mcp — Phase 1B server

Streamable-HTTP Model Context Protocol server for the Enforcer cockpit.
Runs in the Kali NetHunter chroot on the cockpit phone (and, later, on
arm64 swarm nodes via the `enforcer-node` .deb).

Exposes the cockpit's root primitives (shell exec, iface mgmt, attack
profiles, PTY sessions) as MCP tools that LLM agents can drive.

---

## Quick install (inside Kali chroot)

```bash
# Pre-reqs: python3 ≥ 3.11, sudo
sudo mkdir -p /opt/enforcer-mcp /etc/enforcer-mcp
sudo chown $(whoami) /opt/enforcer-mcp /etc/enforcer-mcp

# Copy code into place — adjust path to wherever you scp'd the dir
cp -r ./enforcer-mcp/* /opt/enforcer-mcp/

# Build a virtualenv (no system-package pollution)
cd /opt/enforcer-mcp
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

# Configure
cp /opt/enforcer-mcp/config.yaml.example /etc/enforcer-mcp/config.yaml
nano /etc/enforcer-mcp/config.yaml
#   ↳ paste your bearer token from the cockpit MCP tab // status
#   ↳ confirm port (default 8765) + bind host (127.0.0.1)
```

## Run it

```bash
cd /opt/enforcer-mcp
source .venv/bin/activate
python3 server.py --config /etc/enforcer-mcp/config.yaml
```

You should see JSON log lines like:

```json
{"ts": "...", "level": "info", "msg": "audit.db.opened", "path": "..."}
{"ts": "...", "level": "info", "msg": "tool.registered", "name": "exec_command", "internal": false}
... (one per tool)
{"ts": "...", "level": "info", "msg": "server.startup", "tools": 11, "bind": "127.0.0.1", "port": 8765}
```

`SIGTERM` and `Ctrl-C` shut it down cleanly.

## Smoke tests

Open a second shell *inside the chroot* and run:

```bash
TOKEN="<your-bearer-from-config.yaml>"
BASE="http://127.0.0.1:8765"

# 1. Health (no auth required)
curl -s $BASE/health | jq

# 2. Tool catalog (auth required)
curl -s -H "Authorization: Bearer $TOKEN" $BASE/tools | jq '.tools[].name'

# 3. Audit since beginning of time (auth required)
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/audit/since" | jq

# 4. Call an MCP tool via the streamable-http endpoint
#    (the canonical client is `fastmcp` — install with `pip install fastmcp`)
python3 - <<'PY'
import asyncio, os
from fastmcp import Client

async def main():
    token = os.environ["TOKEN"]
    async with Client(f"http://127.0.0.1:8765/mcp", auth=token) as c:
        tools = await c.list_tools()
        print("Tools available:", [t.name for t in tools])
        # Call exec_command with a benign command
        result = await c.call_tool("exec_command", {"args": {"cmd": "uname -a"}})
        print("Result:", result)

asyncio.run(main())
PY

# 5. Verify it audited
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/audit/since" | jq '.events[-1]'
```

Expected outcome: `tools/list` returns all 11 tools; `exec_command` runs
`uname -a`, returns output, exit_code 0, success true; the audit endpoint
shows the call with timestamp, duration_ms, and a 400-char result_summary.

## Auth failure check

```bash
curl -i http://127.0.0.1:8765/tools           # → 401 missing bearer
curl -i -H "Authorization: Bearer nope" $BASE/tools  # → 403 invalid bearer
curl -i $BASE/health                          # → 200 (always public)
```

## Layout

```
/opt/enforcer-mcp/
  server.py             ← entrypoint
  handlers/
    __init__.py
    internal.py         ← __internal:* tool handlers
  requirements.txt
  README.md
  config.yaml.example   ← copy to /etc/enforcer-mcp/config.yaml
  audit.db              ← created next to config.yaml on first run
  .venv/                ← virtualenv (gitignored)
```

## What's in / not in this phase

✅ **Phase 1B (this build):**
- Streamable-HTTP MCP transport at `/mcp`
- Bearer-token auth middleware
- 11 tools dynamically registered from YAML
- 4 external tools (`exec_command`, `list_ifaces`, `set_monitor_mode`, `set_channel`) — fully working subprocess.run with timeout + audit
- 7 internal handler stubs — return structured "not_implemented" for now, except `read_command_logs` which works
- `/health`, `/tools`, `/audit/since` aux endpoints
- Bounded SQLite audit log (default cap 2000 entries)
- JSON structured logging
- Graceful SIGTERM/SIGINT shutdown

🟡 **Phase 1C (next round):**
- Wire `start_session` / `write_stdin` / `read_session` / `stop_session`
  to real `asyncio.subprocess` PTYs with ring buffers
- Wire `list_attack_profiles` / `run_attack_profile` to either:
  - Shared SQLite read of the cockpit's `attack_profiles` table, OR
  - HTTP callback to a cockpit-exposed `/cockpit/*` endpoint
- Cockpit auto-pushes config.yaml updates when tools registry changes

🔵 **Phase 2:**
- Bind 0.0.0.0 over Tailscale
- Multi-node federation / role tags / `enforcer-node` .deb

## systemd template (future enforcer-node .deb)

A `/lib/systemd/system/enforcer-mcp.service` ships separately when the
.deb is cut. For dev / local you just run `python3 server.py` in a
screen / tmux. Reference template:

```ini
[Unit]
Description=Enforcer MCP Server (FastMCP Streamable HTTP)
After=network-online.target

[Service]
Type=simple
User=enforcer
WorkingDirectory=/opt/enforcer-mcp
Environment=PYTHONUNBUFFERED=1
ExecStart=/opt/enforcer-mcp/.venv/bin/python /opt/enforcer-mcp/server.py --config /etc/enforcer-mcp/config.yaml
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=15
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

## Troubleshooting

**`ModuleNotFoundError: No module named 'fastmcp'`** — venv not activated. `source /opt/enforcer-mcp/.venv/bin/activate`.

**`AttributeError: 'FastMCP' object has no attribute 'http_app'`** — your fastmcp pin is too old. `pip install -U 'fastmcp>=3.4'`. The server tries both `http_app()` and the older `streamable_http_app()` for compatibility, but anything below v2.10 won't have either.

**Bearer rejected even when correct** — tokens are compared lowercase. If you pasted with uppercase hex, the server lowercases on load; double-check no whitespace got in. The middleware also strips with `.strip()` so trailing newlines are fine.

**Tool call returns "command not found"** — the chroot path doesn't have e.g. `iw`, `airmon-ng` installed. `apt install iw aircrack-ng` first.

**`SIGTERM` doesn't shut down** — uvicorn occasionally needs a second signal. Press Ctrl-C twice. Production deploy via systemd handles this with `KillSignal=SIGTERM` + `TimeoutStopSec=15`.

## Hermes integration teaser

Once the server is live, your local Hermes (via the cockpit's AI tab)
can be wired to talk to `http://127.0.0.1:8765/mcp` directly. Drop in
the cockpit-stored bearer token. Hermes gains:

```
> hermes "scan for APs on wlan2 then deauth the first one"
[tool: list_ifaces] → wlan2 monitor channel 1
[tool: exec_command] → airodump-ng -w /tmp/scan wlan2 (timeout 30s)
[tool: parse output] → target BSSID = aa:bb:cc:dd:ee:ff
[tool: run_attack_profile] → deauth_target {bssid, count: 10}
```

Welcome to autonomous offensive wireless. 🛰️
