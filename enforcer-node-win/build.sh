#!/usr/bin/env bash
# Cross-compile the Windows node binary from Linux/macOS.
# Produces dist/enforcer-node.exe — fully static (CGO disabled).
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p dist
echo "→ go mod tidy"
go mod tidy

echo "→ building Windows amd64 (CGO_ENABLED=0)"
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -ldflags "-s -w" -o dist/enforcer-node.exe .

echo "→ also building a native binary for local MCP smoke-testing"
CGO_ENABLED=0 go build -trimpath -o dist/enforcer-node .

echo "done:"
ls -la dist/
