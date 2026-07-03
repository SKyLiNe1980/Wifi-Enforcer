#!/usr/bin/env bash
# vendor-xterm.sh — refresh the bundled xterm.js payload the WebView loads.
#
# Why vendor?
#   Our target device is a Kali NetHunter chroot on Android with tailnet
#   routing quirks. Loading xterm.js from a public CDN (jsDelivr) inside
#   a WebView can hang forever if the tailnet exit node doesn't route to
#   the CDN, or if the chroot's DNS resolver misses the alias. Bundling
#   the JS + CSS inline sidesteps all of that — the WebView pulls no
#   external resources, so the terminal loads even fully offline.
#
# Payload lives at assets/xterm/xterm-bundle.json (Metro treats JSON as a
# regular importable module). XTermView.tsx imports the bundle and inlines
# it into the WebView HTML at render time.
#
# Usage:
#   ./frontend/scripts/vendor-xterm.sh            # default versions
#   XTERM_VER=5.5.0 FIT_VER=0.10.0 ./frontend/scripts/vendor-xterm.sh
#
# Dependencies: curl + python3 (base64 encoding). Both are in every dev
# environment we care about (host or CI).

set -euo pipefail

XTERM_VER="${XTERM_VER:-5.5.0}"
FIT_VER="${FIT_VER:-0.10.0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$FRONTEND_DIR/assets/xterm"
OUT="$OUT_DIR/xterm-bundle.json"
TMPDIR=$(mktemp -d -t vendor-xterm.XXXXXX)
trap 'rm -rf "$TMPDIR"' EXIT

echo "→ downloading xterm@$XTERM_VER + addon-fit@$FIT_VER"
curl -sSfL -o "$TMPDIR/xterm.min.js"   "https://cdn.jsdelivr.net/npm/@xterm/xterm@$XTERM_VER/lib/xterm.min.js"
curl -sSfL -o "$TMPDIR/xterm.min.css"  "https://cdn.jsdelivr.net/npm/@xterm/xterm@$XTERM_VER/css/xterm.min.css"
curl -sSfL -o "$TMPDIR/addon-fit.min.js" "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@$FIT_VER/lib/addon-fit.min.js"

mkdir -p "$OUT_DIR"
python3 - <<PY
import base64, json, os
b = {
    "_note": "Vendored xterm.js + addon-fit. Regenerate via frontend/scripts/vendor-xterm.sh.",
    "xtermVersion":  "$XTERM_VER",
    "fitVersion":    "$FIT_VER",
    "cssContent":    open("$TMPDIR/xterm.min.css").read(),
    "xtermJsB64":    base64.b64encode(open("$TMPDIR/xterm.min.js", "rb").read()).decode(),
    "fitAddonB64":   base64.b64encode(open("$TMPDIR/addon-fit.min.js", "rb").read()).decode(),
}
with open("$OUT", "w") as f: json.dump(b, f)
print(f"✓ wrote {os.path.getsize('$OUT')} bytes to $OUT")
PY
