#!/usr/bin/env bash
# WiFi Enforcer MCP — install
#
# Creates a Python venv (or reuses an existing one), installs the MCP SDK +
# httpx, and prints the config snippets you need for Claude Desktop /
# Hexstrike-AI / CAI / Cline / Continue.
#
# Usage:
#   ./install.sh                       # uses ./venv
#   VENV=~/cai/venv ./install.sh       # reuse the CAI venv
#   STDIO_ONLY=1 ./install.sh          # skip SSE port info

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="${VENV:-$HERE/venv}"
PYTHON="${PYTHON:-python3}"

echo "[wifi-enforcer-mcp] installing into venv: $VENV"

if [ ! -d "$VENV" ]; then
  "$PYTHON" -m venv "$VENV"
fi
# shellcheck source=/dev/null
. "$VENV/bin/activate"

pip install --quiet --upgrade pip
pip install --quiet -r "$HERE/requirements.txt"

echo
echo "✓ installed."
echo
echo "──────────────────────────────────────────────────────────────"
echo "  Test it (stdio mode, default):"
echo "    $VENV/bin/python $HERE/wifi_enforcer_mcp.py"
echo
echo "  Test it (sse mode for remote/Hexstrike):"
echo "    MCP_TRANSPORT=sse MCP_HOST=0.0.0.0 MCP_PORT=8765 \\"
echo "    $VENV/bin/python $HERE/wifi_enforcer_mcp.py"
echo "──────────────────────────────────────────────────────────────"
echo
echo "Claude Desktop config (~/.config/Claude/claude_desktop_config.json):"
cat <<EOF
{
  "mcpServers": {
    "wifi-enforcer": {
      "command": "$VENV/bin/python",
      "args": ["$HERE/wifi_enforcer_mcp.py"],
      "env": {
        "WIFI_ENFORCER_API": "http://127.0.0.1:8001/api"
      }
    }
  }
}
EOF
echo
echo "Hexstrike-AI plugin config snippet (drop into your mcp.yaml):"
cat <<EOF
servers:
  wifi-enforcer:
    transport: sse
    url: http://127.0.0.1:8765/sse
EOF
echo
echo "CAI Framework agent tool import snippet:"
cat <<EOF
# inside your agent definition
from cai.tools.mcp import MCPToolkit
wifi = MCPToolkit.from_command(
    command="$VENV/bin/python",
    args=["$HERE/wifi_enforcer_mcp.py"],
)
agent.add_toolkit(wifi)
EOF
echo
echo "🛑 If anything goes off the rails, you have wifi_panic() as MCP tool"
echo "   AND the '🛑 PANIC' profile in the app — both stop the radios cold."
