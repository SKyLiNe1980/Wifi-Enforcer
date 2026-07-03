# enforcer-mcp — Phase 1B server

Streamable-HTTP Model Context Protocol server for the Enforcer cockpit.
Runs in the Kali NetHunter chroot on the cockpit phone, on the cockpit
itself via autospawn, and on arm64/amd64 **swarm nodes** via the
`enforcer-mcp` .deb (this repo, `packaging/build-deb.sh`).

Exposes the cockpit's root primitives (shell exec, iface mgmt, attack
profiles, PTY sessions) as MCP tools that LLM agents can drive.

---

## Install option A: .deb (swarm nodes, headless boxes)

```bash
./packaging/build-deb.sh
# → dist/enforcer-mcp_0.1.0_all.deb (~30 KB)

scp dist/enforcer-mcp_*.deb node:/tmp/
ssh node 'sudo apt install /tmp/enforcer-mcp_*.deb'
```

On first install the postinst:
1. Creates the `enforcer` system user (no shell, home is `/var/lib/enforcer-mcp`)
2. Generates a fresh `bearer_token_hex` — printed to stdout AND saved to `/etc/enforcer-mcp/config.yaml`
3. Builds the venv at `/opt/enforcer-mcp/.venv` and pip-installs `requirements.txt` (needs internet)
4. Enables + starts `enforcer-mcp.service` via systemd

Verify:
```bash
sudo systemctl status enforcer-mcp
sudo journalctl -u enforcer-mcp -f
curl http://localhost:8765/health
```

`apt install --reinstall` is safe. `apt remove` keeps your config + audit
DB. `apt purge` nukes everything including the system user.

Helper scripts (`wpasec-upload`, `capcheck`) ship as symlinks in `/usr/bin`
so they're in `$PATH` for both the `enforcer` user and anyone else on the
box.

## Install option B: manual (inside Kali chroot)

```bash
# Pre-reqs: python3 ≥ 3.11, sudo
sudo mkdir -p /opt/enforcer-mcp /etc/enforcer-mcp
sudo chown $(whoami) /opt/enforcer-mcp /etc/enforcer-mcp

# Copy code into place — adjust path to wherever you scp'd the dir
cp -r ./enforcer-mcp/* /opt/enforcer-mcp/

# Install the wpa-sec helper scripts into $PATH so the tools can shell them
# out. They live in `scripts/` in this repo; the YAML tool templates call
# them by bare name (`wpasec-upload`, `capcheck`).
sudo install -m 0755 /opt/enforcer-mcp/scripts/wpasec-upload /usr/bin/wpasec-upload
sudo install -m 0755 /opt/enforcer-mcp/scripts/capcheck      /usr/bin/capcheck

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

## Cloud OTA (Redis-as-registry)

To distribute a new `.deb` to a fleet of nodes without SCP'ing to each one
individually, use the four `enforcer-cloud-*` helper scripts. They talk
directly to Upstash Redis over the REST API — no additional daemon
required. The cockpit stores the .deb as a base64 blob under a set of
versioned keys and each node pulls the latest version on demand.

Setup (once):

```bash
cp scripts/enforcer-cloud.env.example ~/.enforcer-cloud.env
chmod 600 ~/.enforcer-cloud.env
# edit and paste your Upstash REST URL + token
```

Cockpit side (push a new build to the cloud):

```bash
packaging/build-deb.sh                       # produces dist/enforcer-mcp_X.Y.Z_all.deb
scripts/enforcer-cloud-push                  # auto-picks newest .deb in dist/
scripts/enforcer-cloud-push --changelog "fix rotate-token race"
scripts/enforcer-cloud-status                # verify what's in the registry now
```

Node side (pull + install the current version):

```bash
enforcer-cloud-pull                          # no-op if already current
enforcer-cloud-pull --force                  # reinstall even if versions match
enforcer-cloud-pull --dry-run                # download + verify sha256, don't install
```

Roll a fleet back a version if a release borks something:

```bash
enforcer-cloud-rollback                      # cockpit: promote previous → latest
                                             # nodes will pull the older version
enforcer-cloud-rollback --local              # local-only: reinstall previous on THIS node
```

All four scripts read Upstash creds from (in override order):
`--url` / `--token` CLI args → `ENFORCER_CLOUD_URL` / `ENFORCER_CLOUD_TOKEN`
env vars → `/etc/enforcer-mcp/cloud.env` → `~/.enforcer-cloud.env`.

Redis key layout:

```
enforcer:mcp:deb:signal              # cheap-to-poll pointer, e.g. "0.3.0"
enforcer:mcp:deb:latest              # JSON meta {version, sha256, size, uploaded_at, ...}
enforcer:mcp:deb:previous            # same shape — rollback target
enforcer:mcp:deb:blob:<version>      # base64-encoded .deb bytes
```

sha256 is verified on the pull side before `dpkg -i` ever runs, so a
compromised or corrupted upload cannot install anything on a node.


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
    sessions.py         ← PTY-backed SessionManager (Phase 1C)
  scripts/
    wpasec-upload       ← wpa-sec.stanev.org community PMKID uploader
    capcheck            ← capture-file sanity / triage helper
  tests/
    test_sessions.py    ← unit tests for SessionManager (5 cases)
    test_mcp_e2e.py     ← end-to-end MCP transport roundtrip
  requirements.txt
  README.md
  config.yaml.example   ← copy to /etc/enforcer-mcp/config.yaml
  audit.db              ← created next to config.yaml on first run
  .venv/                ← virtualenv (gitignored)
```

## Phase 1C session smoke test

After the server is running, validate the PTY tools without leaving curl:

```bash
TOKEN="<your-bearer>"
BASE="http://127.0.0.1:8765"

# Use the fastmcp Python client (it does the JSON-RPC + SSE plumbing).
python3 - <<'PY'
import asyncio, json, os
from fastmcp import Client

async def main():
    async with Client("http://127.0.0.1:8765/mcp", auth=os.environ["TOKEN"]) as c:
        # start an interactive cat session
        r = await c.call_tool("start_session",
            {"args": {"command": "cat", "label": "demo"}})
        sid = json.loads(json.loads(r.content[0].text)["output"])["session_id"]
        print("session:", sid)

        # write a line
        await c.call_tool("write_stdin",
            {"args": {"session_id": sid, "data": "hello pty"}})
        await asyncio.sleep(0.2)

        # read echoed bytes
        r = await c.call_tool("read_session",
            {"args": {"session_id": sid, "tail_bytes": 4096}})
        out = json.loads(json.loads(r.content[0].text)["output"])
        print("read:", repr(out["bytes"]))

        # resize TUI window (sends SIGWINCH to child)
        await c.call_tool("resize_session",
            {"args": {"session_id": sid, "cols": 200, "rows": 60}})

        # list everything
        r = await c.call_tool("list_sessions", {"args": {}})
        print("sessions:", json.loads(json.loads(r.content[0].text)["output"]))

        # stop
        await c.call_tool("stop_session",
            {"args": {"session_id": sid, "signal": "SIGTERM"}})

asyncio.run(main())
PY
```

You should see `'hello pty\r\nhello pty\r\n'` — the doubled line is the
PTY echoing back what we wrote AND `cat` echoing its stdin. That's the
canonical "real TTY" signal: pipes don't double like that.

For real interactive tooling on Android, try:

```python
await c.call_tool("start_session",
    {"args": {"command": "wifite --pmkid -i wlan2", "label": "wifite"}})
```

then poll `read_session` every second or two and `write_stdin` answers
to its prompts. SIGWINCH via `resize_session` is what keeps the ncurses
table rendering cleanly.

## What's in / not in this phase

✅ **Phase 1B (foundation, shipped):**
- Streamable-HTTP MCP transport at `/mcp`
- Bearer-token auth middleware
- Dynamic YAML tool registration
- 4 external tools (`exec_command`, `list_ifaces`, `set_monitor_mode`, `set_channel`)
- `read_command_logs` internal handler
- `/health`, `/tools`, `/audit/since` aux endpoints
- Bounded SQLite audit log (default cap 2000)
- JSON structured logging
- Graceful SIGTERM/SIGINT shutdown
- 3 wpa-sec tools (`wpasec_preview`, `wpasec_upload`, `wpasec_save_key`)

✅ **Phase 1C (this build — sessions are LIVE):**
- Real PTY-backed `SessionManager` (`handlers/sessions.py`)
  - `pty.openpty()` + `TIOCSCTTY` for proper controlling terminal
  - `loop.add_reader` drains master fd → bounded ring buffer (no polling)
  - Per-session `asyncio.Lock` keeps concurrent writes from interleaving
  - `os.setsid()` + `killpg` so the whole child group dies on stop
  - Auto-purge of oldest exited sessions when registry hits `max_sessions`
- 6 working session tools: `start_session`, `write_stdin`, `read_session`,
  `stop_session`, **`list_sessions` (new)**, **`resize_session` (new)**
- 16 total tools registered (4 ext + 6 sessions + 3 wpa-sec + 3 internal)
- Session shutdown wired into FastAPI lifespan so `SIGTERM` cleans up
  every live PTY before the audit DB closes
- New `sessions:` config block: `ring_cap_bytes` (default 64 KiB),
  `max_sessions` (default 16)
- 5-test unit suite (`tests/test_sessions.py`) + MCP-transport round
  trip (`tests/test_mcp_e2e.py`)

🟡 **Phase 1D (next round):**
- `list_attack_profiles` / `run_attack_profile` wired to cockpit
  SQLite `attack_profiles` table (shared-file or HTTP callback)
- Streaming `read_session` cursor (since byte N) so Hermes can tail
  rather than poll
- Cockpit auto-pushes config.yaml updates when its tools registry changes

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
