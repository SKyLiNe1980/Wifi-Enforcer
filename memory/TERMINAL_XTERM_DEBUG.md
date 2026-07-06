# Kali Terminal — xterm.js won't boot (WIP, ~10-15 builds deep)

## Symptom
Kali Terminal tab (app Terminal tab → `TerminalShell.tsx` → renders `XTermView.tsx`;
Live + AI tabs also use XTermView) hangs on `// booting xterm.js…`. xterm never mounts.
User is on Samsung (S10+ primary, also tested S25 Ultra stock). NetHunter chroot.

## CONFIRMED FACTS (don't re-litigate)
- PTY / sessionManager / rootShell pipeline WORKS — shell output flows fine (seen in
  fallback scrollback: zsh running, `ls` output, prompt all correct). ANSI bytes reach RN.
- WebView renders HTML (boot div shows).
- Native RN↔Web bridge WORKS: `injectedJavaScriptBeforeContentLoaded` probe fired
  (`inject-before` diag arrived), and postMessage works.
- Page `<script>` tags DO NOT execute in this WebView (inline body OR file:// src):
  file:// load gave "html loaded" but NO `bootstrap-ran` diag.
- A single LARGE `injectedJavaScript` (~520KB with base64 inlined) SILENTLY DROPS:
  got `inject-before` but never `inject-start`. => Android evaluateJavascript size ceiling.

## Diagnostic ladder tried (all failed to boot xterm)
1. `<script src="data:...base64,{386KB}">` → oversized src attr, parser swallows bootstrap.
2. base64 inline in `<script>` body + baseUrl https://localhost/ → page scripts don't run.
3. file:// html + sibling `<script src="./xterm.js">` (expo-file-system staging) → page
   scripts don't run ("html loaded, waiting", no bootstrap-ran).
4. Full boot via `injectedJavaScript` prop (~520KB) → too big, silently dropped
   (`inject-before` yes, `inject-start` no).
5. **LATEST, UNTESTED BY USER (they went to bed):** stream base64 in ~8KB chunks via
   imperative `webRef.injectJavaScript()` into window.__XB/__FB, then inject small
   `XTERM_BOOT_JS` that atob-decodes + appends as <script> els + boots. onLoadEnd triggers
   `bootXterm()`. Watchdog 12s → fallback.

## Current XTermView.tsx state
- HTML = tiny skeleton (css + #boot + #t), no scripts.
- `XTERM_BOOT_JS` = boot script (no base64): posts inject-start → decodes window.__XB/__FB
  via atob → appends script els → guard `typeof Terminal` → theme/term/fit/open/input/ready.
- `bootXterm()` (onLoadEnd): resets __XB/__FB, feeds 8KB chunks, injects XTERM_BOOT_JS.
- Diag bar (red) in fallback shows last `diag` stage. Stages: inject-before → inject-start
  → lib-injected (Terminal=?/FitAddon=?) → ready. load_error on failure.
- Fallback: ANSI-stripped scrollback + `$` TextInput (line input via onInput). WORKS/usable.

## NEXT MOVES if chunked inject (#5) still fails — read the diag bar first:
- `inject-before` only (no inject-start) again → even chunked final inject dropped, or
  injectJavaScript calls not ordered/executed → try: batch fewer/bigger chunks, or add a
  ready-poll, or move bootXterm trigger off onLoadEnd to a message-driven handshake.
- `inject-start` but `lib-injected: Terminal=undefined` → chunks corrupted/atob failed →
  verify __XB reassembly length vs original; JSON.stringify chunking issue.
- `lib-injected: Terminal=function` but no ready → term.open/fit throwing → check DOM/#t.
- If injection path is fundamentally capped: consider (a) tiny local HTTP server (loopback)
  serving real xterm files so `<script src>` uses http origin (page scripts MAY run from
  http where they don't from file:///about:blank), (b) a lighter terminal lib, (c) confirm
  Android System WebView isn't disabled/ancient on device.
- Pragmatic option user may accept: polish the ANSI-stripped scrollback fallback into the
  primary terminal (it's the old "worked but not perfect" experience) and drop xterm.

## PARKED (agreed, after terminal):
- self_update MCP tool in enforcer-mcp/server.py + cockpit "Update Nodes" button (fire
  enforcer-cloud-pull over MCP link, zero-SSH OTA for the Debian pwn node).
- Move handlers/gtfobins to sit with other tool handlers (tidy).
- NodesMap >8-node grid fallback — shipped, not yet verified on device.

## SHIPPED + (mostly) VERIFIED recently:
- tailnet detection scoped to tailscale0/tun0 (fixed rmnet0 CGNAT grab) — user confirmed
  "tail ip good now".
- NodesMap moved from //status to top of //nodes. Node action buttons 2-col grid.
- Sub-tab bar responsive (numberOfLines/adjustsFontSizeToFit/allowFontScaling=false) — S25 fix.
- Roster TTL 30d→90d (tokenStash). Roster back-fill already exists in handleSaveCloudSync.
- Fork corruption: was transient; restored icons/source from good commits; git workflow &
  .emergent/emergent.yml gitignore resolved with user.

## Build/verify note
xterm/WebView + root PTY are DEVICE-ONLY (EAS build). Cannot test in web preview / Expo Go.
Every attempt costs the user a build + credits — they are LOW ON CREDITS. Prefer diagnostics
that yield the exact failure over blind swings.
