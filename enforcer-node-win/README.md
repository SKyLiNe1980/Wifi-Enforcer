# enforcer-node-win

A Windows-native Enforcer mesh node — a single Go binary that speaks the **same
MCP contract** as the Linux (`enforcer-mcp`) nodes, so the cockpit discovers and
drives it with **zero special-casing**. Targets GPU boxes (hashcat / CUDA).

## What it exposes (identical to the Python nodes)

- `GET /health` — public (no auth). Reports `tools`, `capabilities`, `node`,
  `version`. The cockpit's `probeNode` reads this.
- `POST /mcp` — MCP 2025 Streamable-HTTP (JSON-RPC 2.0): `initialize`
  (returns an `Mcp-Session-Id` header) → `notifications/initialized` →
  `tools/list` / `tools/call`. `DELETE /mcp` tears down the session.
- `GET /tools` — aux JSON listing for the cockpit's `// tools` tab.
- **Auth:** `Authorization: Bearer <hex>` on everything except `/health`
  (same `require_token` semantics as Linux).

Implemented on the Go **standard library** (`net/http`) — no MCP SDK, no cgo.
`net/http` is a full production HTTP server, reachable over the Tailscale
interface exactly like the other nodes.

## Tools (Phase 1)

| tool           | args            | notes                                   |
|----------------|-----------------|-----------------------------------------|
| `exec_command` | `{ cmd }`       | runs `cmd /C <cmd>` (parity w/ Linux)   |
| `hashcat`      | `{ args }`      | runs `<hashcat_path> <args>` (sync)     |

`capabilities` are config-driven; `"cuda"` is auto-added at runtime if
`nvidia-smi` is on PATH.

## Build

**From Linux/macOS (cross-compile):**
```bash
./build.sh          # → dist/enforcer-node.exe  (+ a native binary for testing)
```

**On Windows:**
```powershell
.\build.ps1         # → dist\enforcer-node.exe
```

Requires a Go toolchain (1.22+). `go mod tidy` fetches the only two deps:
`golang.org/x/sys` (SCM) and `gopkg.in/yaml.v3` (config).

## Test the MCP surface WITHOUT a Windows box

Because the core is plain `net/http`, the same code runs on Linux:
```bash
go build -o enforcer-node .
cp config.example.yaml config.yaml   # set a bearer token
./enforcer-node run --config config.yaml &

curl -s localhost:8765/health | jq .

# Full MCP handshake (what the cockpit does):
TOKEN=$(grep bearer config.yaml | cut -d'"' -f2)
curl -s -X POST localhost:8765/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' -i | grep -i mcp-session-id
curl -s -X POST localhost:8765/mcp -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"exec_command","arguments":{"cmd":"echo hi"}}}'
```

## Install on a Windows node

Prereqs: Tailscale installed + `tailscale up`. hashcat optional.

1. Copy `dist\enforcer-node.exe` + `install.ps1` to the node.
2. Elevated PowerShell:
   ```powershell
   .\install.ps1 -Bearer <64-hex-from-cockpit> -Name win-gpu-01
   ```
   This drops the binary + `config.yaml` into `C:\Program Files\enforcer-node`,
   opens the firewall port, and registers an **auto-start service with
   restart-on-failure** (the Windows analogue of systemd `Restart=`).
3. In the cockpit, add the node (same bearer) — it appears on the mesh.

Manual service control:
```
enforcer-node.exe install --config <path>
enforcer-node.exe start | stop | uninstall
enforcer-node.exe run --config <path>     # foreground / debug
```

## Not in Phase 1 (planned)

- **Phase 2:** per-user tray helper (green/red mesh-connectivity dot). A Windows
  service runs in session 0 with no desktop, so the tray must be a separate
  autostart helper polling `localhost/health`.
- **Phase 3:** cockpit reads `capabilities` and adds hashcat **job dispatch**
  (submit → run → stream/return results) instead of synchronous `tools/call`.
