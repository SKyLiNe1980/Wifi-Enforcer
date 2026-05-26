# WiFi Enforcer — MCP Server

Expose your rooted Android pentest cockpit (WiFi Enforcer + Kali NetHunter chroot + 3-AWUS rig) as **Model Context Protocol** tools so Claude Desktop, Hexstrike-AI, CAI swarms, Hermes, Cline, Continue, and any other MCP-aware agent can drive it autonomously.

## What this gets you

Your phone runs the WiFi Enforcer FastAPI backend (mock-or-real-or-kali execution). This little MCP server sits in front of it and translates structured tool calls into HTTP requests. Agents on your laptop (Claude Desktop, etc.) connect to this server and suddenly have **15 wifi-pentest superpowers** as first-class tools.

## Tools exposed

**Inspection (safe):**
- `wifi_get_settings` — current exec mode, ifaces, country
- `wifi_list_profiles` — saved attack/defense sequences
- `wifi_list_logs` — recent command outputs
- `wifi_diag` — full wireless-stack snapshot (reg, phys, dmesg)
- `wifi_get_health` — root status, device model, OS
- `wifi_get_audit_log` — what the agent swarm has been doing

**Action (writes / fires commands):**
- `wifi_execute(command, mode)` — arbitrary shell, mock/real/kali
- `wifi_run_profile(name)` — execute a saved sequence
- `wifi_create_profile / wifi_delete_profile` — let agents build their own recipes
- `wifi_set_iface_context(a,b,c,active)` — multi-adapter switching
- `wifi_set_exec_mode(mode)` — persistently change exec mode
- `wifi_set_country(code)` — `iw reg set <CC>` shortcut

**Emergency:**
- `wifi_panic` — kill all kali processes, reset regdomain, bring monitor-mode adapters down, re-enable normal wifi.

## Install

On the device (S10+) or wherever your WiFi Enforcer backend runs:

```bash
cd /path/to/wifi-enforcer/mcp
./install.sh
```

The script creates a venv, installs the MCP SDK + httpx, and prints the exact config snippets for:
- Claude Desktop
- Hexstrike-AI
- CAI Framework

## Run it

### stdio mode (Claude Desktop, Cline, Continue, local CAI)
```bash
./venv/bin/python wifi_enforcer_mcp.py
```
The MCP client launches it; you don't manually start it.

### SSE / HTTP mode (Hexstrike-AI, remote laptop frontend)
```bash
MCP_TRANSPORT=sse MCP_HOST=0.0.0.0 MCP_PORT=8765 \
  ./venv/bin/python wifi_enforcer_mcp.py
```
Then point Hexstrike-AI's `mcp.yaml` at `http://<phone-ip>:8765/sse`.

## Environment variables

| Var | Default | What |
|---|---|---|
| `WIFI_ENFORCER_API` | `http://127.0.0.1:8001/api` | Where the FastAPI backend lives |
| `AUDIT_LOG_PATH` | `/sdcard/wifi_enforcer_mcp_audit.jsonl` | Where to append per-call records (falls back to /tmp if /sdcard not writable) |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `sse` |
| `MCP_HOST` | `127.0.0.1` | SSE bind host |
| `MCP_PORT` | `8765` | SSE port |

## Audit log

Every MCP tool call is appended as one JSON line to the audit log. Inspect it with:

```bash
tail -f /sdcard/wifi_enforcer_mcp_audit.jsonl | jq .
```

Or via the `wifi_get_audit_log` tool itself (agents can self-introspect).

## Safety model

This server has **no allow-list**. Agents have the same capability surface as a human user of the app — which is full root on a NetHunter device. By design.

If you want to lock it down later:
- Add allow-regex filtering in the `wifi_execute` body
- Wrap `wifi_run_profile` to require an environment variable like `MCP_REQUIRE_CONFIRM=1` that pushes a notification you approve from the phone
- Use the MCP `Roots` feature for fs scope (not relevant here since we don't touch fs)

## Example agent prompts

Once installed, your agents can do things like:

> *"Map the local WiFi landscape, capture PMKIDs from WPA2 networks without sending deauths, save the hashcat-formatted file to /sdcard/pmkids.hc22000, then PANIC stop."*

> *"Check current regulatory domain, switch to KE if not already, max out TX power on wlan2, set monitor mode, and report the new state."*

> *"Create a profile called 'Recon Phase 1' that runs: airmon-ng check kill; iw dev wlan2 set type monitor; ifconfig wlan2 up; airodump-ng -i wlan2 --write /sdcard/recon"*

The agent figures out which tools to call in what order. You watch the audit log scroll.

## Architecture

```
Claude Desktop / Hermes / CAI agent / Hexstrike-AI
                       │
                       │  MCP (stdio or SSE)
                       ▼
              wifi_enforcer_mcp.py  ← this server
                       │
                       │  HTTP localhost:8001/api/*
                       ▼
              WiFi Enforcer FastAPI
                       │
                       ▼
              Native bridge (su -c / bootkali custom_cmd)
                       │
                       ▼
              S10+ Kali chroot + 3× AWUS radios 📡
```

## Troubleshooting

**"connection refused" / API unreachable** — check the FastAPI backend is running (`curl http://127.0.0.1:8001/api/health`). If it's on a different host/port, set `WIFI_ENFORCER_API`.

**Audit log not writing** — `/sdcard` may not be writable from the venv's process context. The server falls back to `/tmp/wifi_enforcer_mcp_audit.jsonl` automatically; check there.

**Tool calls return mocked output** — the backend is in MOCK mode. Use `wifi_set_exec_mode("kali")` to switch (assumes you're on the device with the native bridge installed).

**Agents are too eager / running risky commands** — add `wifi_panic` to your agent's "always available" tools list and instruct them in the system prompt: *"If anything looks wrong or you're unsure, call wifi_panic first."*
