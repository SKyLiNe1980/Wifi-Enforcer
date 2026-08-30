# Enforcer Cockpit — PRD / Change Log

Native (Android root-shell) Expo app + FastAPI `enforcer-mcp` backend for a
Tailscale-connected pentest node swarm. Nodes are mirrored to Upstash Redis
for reinstall recovery. NOTE: app is native-only (expo-sqlite + root shell);
it does NOT render in the web preview (expo-sqlite web worker crashes) — this
is expected and unrelated to feature work.

## Recent fixes

### Cockpit probe host resets to 127.0.0.1 on reinstall (FIXED)
- Bug: after a fresh APK reinstall, `cockpit_probe_host` reverted to the
  loopback default `127.0.0.1` even though `bind_host` correctly restored to
  the node's tailnet IP. Cockpit then probed localhost → node listed UNREACH.
- Root cause: reinstall wipes SQLite (probe host re-seeds to 127.0.0.1). The
  chroot auto-sync (`applyChrootYaml`) restored `bind_host` from the server's
  `config.yaml` `server.host` but never mirrored it into `cockpit_probe_host`.
  Live `detectTailnetIp()` also no-ops on userspace-networking chroots.
- Fix:
  - `frontend/src/lib/localDb.ts` → `applyChrootYaml`: when importing `host`,
    also set `cockpit_probe_host = host` IF current probe host is still the
    loopback default AND host is routable (not 127.0.0.1 / 0.0.0.0). Operator
    overrides are preserved.
  - `frontend/src/components/MCPTab.tsx` → tailnet auto-detect effect: if
    `detectTailnetIp()` returns null, fall back to the routable `bind_host`.
- Validation: frontend-only; tsc/lint clean. Native SQLite path can only be
  verified on a real APK build (not web preview / testing_agent).

### Upstash cloud roster wipe on fresh reinstall (FIXED)
- Bug: saving Upstash creds on a fresh install pushed the EMPTY local roster
  to the cloud (`pushRoster(url, tok, [])`), wiping the cloud database before
  it could be pulled.
- Fix (`frontend/src/components/MCPTab.tsx` → `handleSaveCloudSync`):
  - If local roster is EMPTY → PULL from cloud and auto-restore nodes into
    local SQLite (never push `[]`).
  - If local roster is NON-EMPTY → push snapshot as before.
  - If both empty → store creds only, no destructive write.
  - `handleSnapshotNow` also guarded: refuses to overwrite a non-empty cloud
    roster with an empty local one.

### enforcer-mcp service fails to start (missing audit db_path) (FIXED)
- Bug: generated `/etc/enforcer-mcp/config.yaml` lacked `db_path`, so server.py
  fell back to the /etc "next-to-config" path which is read-only under systemd
  ProtectSystem=full → crash loop. Manual add of `db_path` under `server:` fixed it.
- Fix:
  - `enforcer-mcp/config.yaml.example`: `server.db_path` now shipped in template.
  - `packaging/debian/postinst`: db_path injection is now idempotent (skips if
    present) AND self-heals existing broken configs on the upgrade path.
- Verified: config generation + server.py db_path resolution + sqlite open.

### Node self-heal + cockpit-first provisioning (Phase A+B)
Goal: extend "autospawn" beyond the local cockpit node to the whole fleet,
cockpit-first (minimal manual SSH), without weakening the `enforcer` account.

**Phase A — node self-heal (shipped in the .deb):**
- `packaging/initd/enforcer-mcp` — SysV init (start|stop|status|restart) with
  a pidfile; launches `enforcer-mcp-supervise` (a restart loop) so crashes
  auto-respawn on non-systemd/chroot nodes (systemd nodes keep `Restart=`).
- `scripts/enforcer-mcp-supervise` — respawn loop (runs as root → mon-mode OK).
- `scripts/enforcer-mcp-watchdog` — cron safety net (`/etc/cron.d/enforcer-mcp`,
  every 2 min): restarts if down or if `/health` doesn't answer.
- `postinst` non-systemd branch now installs init.d (`update-rc.d`) + cron +
  starts via init.d (was previously just a "managed by cockpit" message).
- `build-deb.sh` ships the init.d script; scripts auto-symlinked to /usr/bin.
- Verified: `sh -n` on all scripts, watchdog port-parse against config, and
  `dpkg-deb --contents` shows the new files in enforcer-mcp_0.3.8_all.deb.

**Phase B — cockpit Add-Node wizard + remote revive (frontend):**
- `src/lib/nodeProvision.ts` — provisionNode() (bootstrap key via sshpass ONCE
  → install .deb over tailnet httpd → sed bearer/bind into config.yaml + write
  cloud.env → start + /health check) and reviveNode() (key-based SSH restart,
  systemd-then-init.d). All remote scripts are base64'd and `base64 -d | sh`
  to avoid nested-quote issues (encoder verified byte-for-byte vs real base64).
- `src/components/ProvisionNodeModal.tsx` — guided wizard UI with streaming log.
- `MCPTab.tsx` — PROVISION NODE button; "Auto-revive unreachable nodes" toggle
  (config.remote_revive_enabled); probeNode drives auto-revive after ~30s
  unreachable with a 2-min per-node cooldown.
- `localDb.ts` — schema v12 adds `remote_revive_enabled`.

Auth model: cockpit generates ONE ed25519 keypair in the Kali chroot; operator's
root password is used ONCE (sshpass) to add that pubkey to the login user's
authorized_keys. Nothing on the node's login policy changes; enforcer stays
/nologin. Revive reuses the same key.

CANNOT be tested in sandbox/Expo Go (needs native root shell + real nodes + SSH).
Verification here = lint + shellcheck-style + base64 correctness + .deb build.
Requires on-device build test by the operator.

### Follow-up fixes (bearer persistence, roster-authoritative restore, adopt-node revive)
- **Bearer never expires:** `rotateBearer` writes `enforcer:bearer:current` with
  NO TTL (was 30-min `EX`). Redis expiry deletes the whole key, which is why the
  key "vanished" — not an installer wipe. Confirmed nothing in app/scripts DELs
  the bearer/roster keys (only `enforcer-cloud-restore --wipe` touches
  `enforcer:mcp:*`, a different namespace, opt-in).
- **RESTORE FROM CLOUD is roster-authoritative:** iterates the Redis roster and
  restores exactly those nodes; tailnet discovery is used ONLY to refresh a known
  member's live IP, never to mass-add `enforcer-node`-named peers. Empty roster →
  errors instead of tailnet fallback.
- **Adopt-an-old-node revive:** per-node `ssh_user`/`ssh_port` (schema v13);
  Edit Node now has SSH user/port fields + "INSTALL KEY" (one-time password
  bootstrap of the cockpit revive key) + "REVIVE NOW". reviveNode/auto-revive use
  per-node SSH details. `installReviveKey()` added to nodeProvision.ts.

### Windows (win64) node — Phase 1 (`/app/enforcer-node-win/`)
Go binary that speaks the SAME contract as the Python nodes so the cockpit
drives it with zero special-casing. Hand-rolled MCP on the Go **stdlib**
(`net/http`) — no MCP SDK, no cgo (`CGO_ENABLED=0`).
- Endpoints: public `GET /health` (reports tools + `capabilities` + node/version),
  `POST /mcp` MCP 2025 Streamable-HTTP (initialize→Mcp-Session-Id header→
  notifications/initialized→tools/list/tools/call, DELETE teardown), aux
  `GET /tools`; bearer middleware (skips /health), all mirroring server.py.
- Tools: `exec_command` ({cmd}, cmd /C) + `hashcat` ({args}). `capabilities`
  config-driven; auto-appends "cuda" if nvidia-smi present.
- Windows service via `golang.org/x/sys/windows/svc` + `mgr` (auto-start +
  SetRecoveryActions restart-on-failure = Windows analogue of systemd Restart=)
  + eventlog. Self-installing: `enforcer-node.exe install|uninstall|start|stop|run`.
- Cross-platform core: same binary runs on Linux (`run`) for MCP smoke-testing
  without a Windows box (service code is build-tagged windows-only + Linux stubs).
- Files: go.mod, main.go, config.go, server.go, tools.go, service_windows.go,
  service_other.go, config.example.yaml, build.sh/build.ps1, install.ps1, README.md.
- NOT tested here (no Go toolchain in sandbox). Verify: `./build.sh` then run the
  Linux binary + curl the MCP handshake (README has the exact commands), then
  build .exe + install.ps1 on the Windows box.
- Deferred: Phase 2 tray helper (session-0 service can't own a tray → separate
  per-user autostart helper polling localhost/health); Phase 3 cockpit reads
  capabilities + hashcat job dispatch (replaces synchronous tools/call).

### Provision wizard: crash fix + dual auth modes
- **Crash fix (JNI weak-ref overflow):** the deploy crash was
  `NativeAnimatedModule` weak global-ref table overflow (~50k refs). Root cause:
  `ProvisionNodeModal` used `<Modal animationType="slide">` + an
  `ActivityIndicator`, and stayed open for the whole multi-minute deploy while
  MCPTab's background timers re-rendered it — bleeding Animated weak-refs until
  the JNI table overflowed. Fixed by `animationType="none"` + removing the
  ActivityIndicator (there is zero JS Animated usage elsewhere). Frontend-only.
- **Dual auth modes:** wizard now has "Password (public IP)" vs "Tailscale SSH
  (tailnet)". Tailscale mode uses `tailscale ssh <user>@<host>` (no password/key
  bootstrap — tailnet identity is the auth) and no longer blocks on empty
  user/pass. Password mode unchanged (sshpass one-time key bootstrap). Added
  `authMode` to ProvisionOpts + `tailscaleSSHExec()`; password field is hidden
  in tailscale mode. Note: tailscale-ssh first use may need a one-time manual
  `tailscale ssh` to clear device auth (documented in the wizard hint).

### Floating Command Toolbar — Phase 1 (DONE)
- Global, draggable SDR/military-radio HUD, mounted in `app/_layout.tsx` (wrapped
  in `GestureHandlerRootView`, rendered after the `<Stack>` so it floats over all
  screens). Defaults to ON.
- Files:
  - `src/components/FloatingToolbar.tsx` — collapsed 56px bubble ↔ expanded
    gunmetal bar (expo-linear-gradient + Reanimated). Pan drag + edge snap +
    vertical clamp to safe area. Rigid haptics on press/expand. LED feedback per
    slot (idle/firing/ok/err). Left/right 60px bays reserved for Phase-2 dials.
  - `src/components/ToolbarConfigModal.tsx` — "Config Bottom Sheet" (plain Modal,
    `animationType="fade"` to avoid the JNI Animated crash). Master enable toggle,
    add/edit/reorder/delete slots, pick action type (MCP tool / app action /
    navigate), icon, label, LED colour swatch, target node, tool + args
    (`key=value` per line).
  - `src/lib/toolbarStore.ts` — kv-backed config (slots + position + enabled),
    tiny pub/sub. `src/lib/toolbarActions.ts` — executes slot (MCP call / app
    action snapshot·restore·revive / route nav) → uniform {ok, detail}.
- Settings → General → `// command overlay` has an ARM/OFF toggle (mirrors
  `toolbarStore.enabled` via subscribe).
- Validation: lint clean, tsc clean for toolbar files. Web preview CANNOT render
  this app (pre-existing: expo-sqlite web worker imports `.wasm`, not in
  metro assetExts which must not be modified) → drag/haptics/LEDs to be verified
  on the APK build.
- Deferred Phase 2: TX-power/CH knurled dials + MODE/SCAN/EXEC pill wiring
  (bays + pills already laid out as placeholders).

### Floating toolbar — crash fixes + native system overlay
- **Crash fix (force-close on drag):** the Pan gesture `onEnd` worklet called
  `Dimensions.get("window")` on the UI thread → "undefined is not a function"
  (worklet runtime has no Dimensions) → FATAL. Fixed by capturing `SCREEN_H`
  as a module constant and using it in the worklet. (FloatingToolbar.tsx)
- **Fix (back-swipe/exit):** default "LIVE" slot navigated to "/(tabs)/live",
  a route that doesn't exist in this single-screen app. Replaced default with a
  "PULL" (cloud restore) app action + `loadToolbarConfig` migrates any persisted
  legacy `/(tabs)/*` navigate slot; navigate action now try/catch-guarded.

### Native over-other-apps overlay (Android) — NEW
- Purpose: the in-app RN toolbar only floats over Enforcer's own screens; the
  operator wanted a bubble that stays on top of OTHER apps. That requires a
  native Android overlay (foreground service + SYSTEM_ALERT_WINDOW +
  WindowManager) — impossible from pure RN.
- Native (in plugins/android, wired by plugins/withOverlay.js at prebuild):
  - `OverlayModule.kt` (NativeModules.OverlayControl): hasPermission,
    requestPermission, syncConfig(json), show, hide, isRunning,
    consumePendingSlot.
  - `OverlayService.kt`: foreground service (specialUse) drawing a draggable
    bubble that expands to tactical buttons via WindowManager
    TYPE_APPLICATION_OVERLAY. MCP-tool buttons fire the MCP tools/call directly
    over HTTP in-service (mirrors mcpClient.ts) — works over other apps, no app
    focus. app/navigate buttons stash the slot id + launch the app (allowed:
    SYSTEM_ALERT_WINDOW grants background-activity-launch exemption).
  - `OverlayPackage.kt`; `withOverlay.js` copies sources, registers the package
    in MainApplication, adds SYSTEM_ALERT_WINDOW/FOREGROUND_SERVICE(_SPECIAL_USE)
    perms + <service android:foregroundServiceType="specialUse">, proguard keeps.
- RN: `src/lib/overlayControl.ts` (graceful no-op when native absent). index.tsx
  syncs resolved slot config (node host/port/token inlined for MCP slots) on
  load/subscribe/foreground, consumes pending overlay taps (runs executeSlot),
  and Settings → General → "over other apps" arms/disarms + requests permission.
  Config field `systemOverlay` added to toolbarStore; when armed the in-app RN
  toolbar hides (native one supersedes).
- Validation: lint + tsc clean; `expo config --type introspect` confirms manifest
  perms/service; Metro resolved all 1502 modules for android (Hermes bytecode
  step only fails in-sandbox due to hermesc arch — runs fine on EAS). ONLY
  testable on the installed APK (`eas build -p android --profile preview`), not
  Expo Go / web preview.

### Round 2 fixes (user feedback on APK build)
- **Toolbar expand bug (in-app + native):** expanding lost drag + fell half off
  screen. RN FloatingToolbar: on expand it now docks the bar to a fully
  on-screen bottom slot and disables free-drag while expanded (the horizontal
  ScrollView was fighting the pan); collapsing restores the bubble to its saved
  spot. Native OverlayService: added clampToScreen() (post-layout) called on
  expand/drag-end/rebuild so the wider bar can't hang off the edge and strand
  the drag-handle bubble.
- **Tailscale SSH:** dropped the `user@` prefix — `tailscale ssh <host>` now
  (was `root@<ip>` → "connection closed by UNKNOWN port 65535" when ACL didn't
  grant root; matches the operator's working manual `tailscale ssh <host>`).
  ProvisionNodeModal hides the SSH user + port fields entirely in Tailscale mode.
- **Deploy prefill:** modal now prefills BOTH cloud URL and cloud token from the
  running config (loadUpstashUrl + loadUpstashToken) as suggestions.
- **SNAP/action feedback:** in-app toolbar and overlay-launched app actions now
  show an Android toast with the result detail (SNAP was succeeding silently).

### Tailscale deploy still failing — diagnosis + DIAG tool (round 3)
- Symptom persists after dropping user@: "Connection closed by UNKNOWN port
  65535" + RAW "/system/bin/sh: No such file or directory".
- Analysis: execReal runs `su` → command → Android's /system/bin/sh, then the
  chroot prefix drops into Kali. The remote target of `tailscale ssh` would use
  ITS OWN /bin/sh; a /system/bin/sh error therefore means the SSH is landing on
  an ANDROID node (the phone / another android peer), NOT the codespace. User's
  working manual cmd used MagicDNS name `codespaces-f91bc7`; app used IP
  100.99.68.115 → likely the wrong/an-android host.
- Added: ProvisionNodeModal "TS DIAG — probe host" button (tailscale mode) that
  runs `command -v tailscale; tailscale status; tailscale ssh <host> echo TS_OK`
  inside the chroot and dumps raw output+exit. Also a UI tip to use the MagicDNS
  name, and host placeholder now shows `codespaces-xxxx`.
- Immediate (no rebuild) repro for user: run in app Terminal (KALI mode):
  `tailscale ssh codespaces-f91bc7 echo TS_OK; echo EXIT=$?`  vs the IP.

### Tailscale deploy ROOT CAUSE FOUND (round 4)
- Manual Test A + B both returned TS_OK EXIT=0 → host + wrapper fine.
- Root cause: chroot helper uses `sudo -E` (preserves env). App exec path is
  Android `Runtime.exec("su")` (SHELL=/system/bin/sh) → sudo -E leaks that
  SHELL into Kali → `tailscale ssh` falls back to $SHELL=/system/bin/sh (absent
  in chroot) → "/system/bin/sh: No such file or directory" → "connection closed
  by UNKNOWN port 65535". Manual works because interactive Kali shell has
  SHELL=/bin/bash. Python/wifite unaffected (don't use $SHELL).
- Fix: tailscaleSSHExec now prepends `SHELL=/bin/bash HOME=/root TERM=xterm`
  before `tailscale ssh`. DIAG probe also echoes SHELL/HOME/TERM + uses the same
  env pin. (nodeProvision.ts, ProvisionNodeModal.tsx)
- Manual instant confirm (no rebuild): `SHELL=/system/bin/sh tailscale ssh
  100.99.68.115 echo TS_OK` should REPRODUCE the error; adding
  `SHELL=/bin/bash` should fix it.

### Tailscale deploy — SHELL fix WORKED; new hang + crash (round 5)
- Target log now shows SSH connects + "Session complete" (SHELL pin fixed the
  auth). But app hangs on "probing" then crashes.
- Root cause of hang: `tailscale ssh --has-tty=false` forwards stdin and waits
  for EOF; our `su` exec pipe keeps stdin open → client never exits even after
  remote finishes → app stuck ~6 min → JNI weak-ref table overflow
  (NativeAnimatedModule, 50857 refs) SIGABRT crash.
- Fix: tailscaleSSHExec now `timeout 180 tailscale ssh … "<script>" </dev/null`
  (ssh -n style stdin EOF + hard cap). DIAG probe: `timeout 30 … </dev/null`.
- Defensive: set ToolbarConfigModal + LiveTab endpoint modal animationType
  "none" (this device's known NativeAnimatedModule weak-ref leak; prior crash
  was fixed the same way for ProvisionNodeModal).
- STILL TO ROOT-CAUSE NEXT TIME: the underlying NativeAnimatedModule weak-ref
  leak on this LineageOS/new-arch device (accumulates ~132/s the whole session;
  no continuous Animated/withRepeat found in our code — likely RN new-arch
  TurboModule weak-ref leak or a Modal/dependency driver). The timeout fix
  prevents the long hang that lets it overflow, but the slow leak remains.

### Toolbar switcheroo fix (round 6)
- Report: native over-other-apps drag is fixed, but the IN-APP toolbar now
  breaks (static/half-off/undraggable) AFTER using the overlay.
- Cause: FloatingToolbar is always mounted in root layout; while systemOverlay
  is armed it `return null`s but the component instance persists, so `expanded`
  + animated shared values (w/h/tx/ty/expSV) stay frozen. On disarm it returns
  in that stale (often expanded → pan disabled) state; the one-shot load effect
  doesn't re-run.
- Fix: added effect detecting systemOverlay true→false transition (prevOverlay
  ref) that resets expanded=false, expSV=0, w/h/r to bubble geometry, and
  tx/ty to bubblePos.current (last known bubble spot). (FloatingToolbar.tsx)
- Open (cosmetic): in-app RN toolbar (expo-linear-gradient HUD: gradients,
  screws, LED strips, MODE/SCAN/EXEC pills, TX/CH bays) vs native overlay
  (OverlayService.kt basic Kotlin Views, flat colors) look different by design.
  Aligning requires drawing gradients/LED/screws natively — deferred.

### BACKLOG — provisioning robustness (user note, defer)
- Provisioning currently assumes preconditions exist; a missing dependency for a
  selected option (e.g. cron watcher chosen but cron/crontab not installed) has
  no recovery → step fails or hangs. "Fine for now" per user.
- Future hardening: preflight capability-probe each selected feature and adapt:
    * `command -v crontab` → else systemd timer → else init.d → else skip+warn
    * detect `systemctl` vs `service`; verify .deb actually installed (dpkg -l)
    * wrap every remote step in `timeout` (already done for the ping) so nothing
      can hang the app
    * surface a clear per-step "OK / skipped (reason) / failed" summary in the log

### Windows Node Phase 3 — Hashcat dispatch + GPU badge + version (DONE, needs on-device test)
- Node version visibility (user's realization): /health already returns `version`
  and it's stored in node.last_health_info — was just never shown. Now the // node
  list card shows `· v<version>`. No new plumbing.
- Capabilities-aware: reads `capabilities` from last_health_info. If it includes
  hashcat/cuda/gpu → shows a GPU badge + per-cap tags on the node card AND a small
  amber GPU chip badge on the node marker in NodesMap.
- Hashcat dispatch: GPU-capable node cards get a ⚡CRACK button → modal composes a
  raw hashcat arg string (quick chips: WPA 22000 / NTLM 1000 / MD5 0 / sha512crypt
  1800) and fires the node's `hashcat` MCP tool ({args}) via callMcpTool; result
  text dumped in-modal. Synchronous (120s client timeout) — Phase-3 streaming TODO.
- Contracts: enforcer-node-win /health → {version,capabilities,tools}; `hashcat`
  tool takes {args:"<cli string>"} → runs `<hashcat_path> <args>`. enforcer-mcp
  (Linux) /health returns version but NOT capabilities yet — to light up the Linux
  GPU rigs (H200/3090), enforcer-mcp needs a capabilities field + hashcat tool
  (server-side change → node redeploy). Frontend is already capability-agnostic.
- Files: MCPTab.tsx (state crackNode/crackArgs/crackOut, runCrack, card version+
  badge+CRACK btn, dispatch modal), NodesMap.tsx (gpu chip badge + style).
- Deferred per user: UEF (lives in Live/term, needs compact+full dual UI) and
  Orchestration (own tab; backend = Ergo IRC API+WS + A2A/MCP + eggdrop taskers +
  heartbeats/goals/contracts, not finalized). Build rich UI once contracts exist.

### NEXT SESSION — PRIORITY: bearer-token auth may be broken (SECURITY)
- User observation: the `pwn-` node runs on a DIFFERENT bearer token than the
  cockpit has stored, yet calls succeed with no auth failures → bearer auth is
  likely NOT being enforced.
- Suspects to check first:
  * enforcer-mcp BearerAuthMiddleware — is it actually comparing tokens, or
    only gating on presence? Timing-safe compare? (server.py ~L134-144)
  * `require_token` resolution — config.yaml vs env vs default; if it reads
    false/missing, middleware may allow all. Confirm /health vs /mcp gating.
  * enforcer-node-win auth path (Go) — same check: does it reject wrong/absent
    Bearer on /mcp (everything except /health)?
  * Token desync from the /etc vs ~/.enforcer-cloud.env precedence (see prior
    note) — node may be loading a token the cockpit no longer uses, but that
    still shouldn't ACCEPT a wrong token.
- Repro to build: call a node's /mcp with (a) correct, (b) wrong, (c) no bearer;
  expect 200 / 401 / 401. If all 200 → confirmed broken.
- Treat as security bug; also consider surfacing an auth-status indicator per
  node in the cockpit once fixed.

### SWAT / Orchestration tab — Phase A DONE (per Hermes swat-app-tab-spec.md)
- Transport: IRC-over-WebSocket to Ergo (ws://<host>:<port>, default
  100.83.194.121:7778, #SWAT). Plain RN WebSocket, no new deps.
- New files:
  * src/lib/swatIrc.ts — singleton IRC client + store: connect → NICK/USER →
    (001) JOIN → PING/PONG keepalive → parse PRIVMSG/353 NAMES/JOIN/PART/QUIT/
    NICK → roster tracking → event feed (cap 500) → 4s auto-reconnect. Config in
    localDb kv ("swat_config"). Exports connect/disconnect/swatSend/subscribe/
    getState/loadConfig/saveConfig/isCommander/stripIrc/parseIrcColored.
  * src/components/SwatTab.tsx — connection LED + host/nick strip (★ for
    commander), inline gear config panel (host/port/nick/channel/autoconnect,
    Save&Reconnect), roster chips, verb/colour feed w/ auto-scroll + jump btn,
    bottom send box (enabled when connected).
- Colour: per user, the TCL conductor emits mIRC \x03 colour codes; app now
  HONOURS server colours (parseIrcColored → coloured <Text> segments, 16-colour
  palette nudged for dark bg) and only falls back to verb-colour for uncoloured
  lines. (Spec's "strip+recolor" superseded by user's TCL-drives-colour choice.)
- Wired into app/index.tsx: tab union + render + TabBtn ("swat", shield-account).
- Commander verbs/mission composer + gating = Phase B (COMMANDERS hardcoded:
  Maarten, Enforcer-Operator). Basic PRIVMSG send is live now.
- Testing: needs a live Ergo WS on the tailnet (unreachable from sandbox) + real
  device (SQLite). lint + tsc clean → on-device verification via APK.

### USER PREFERENCES (permanent — read every session)
- User builds REAL Android APKs every session (eas build -p android ...). ANDROID
  ONLY — no iOS, ever. => In finish summaries, DO NOT append the boilerplate
  "Notes" block about dev/preview/Publish/Expo Go/iOS. Skip it entirely.
- On-device is the real test bed; web preview can't run the app (SQLite/native).

### SWAT tab — Phase B DONE (commander controls)
- Quick verb chips above the send box (SwatTab.tsx):
  * anyone: STATUS, LEASES, HELP (fire immediately) · TASK @all, STOP # (prefill
    input for target/payload)
  * commander-only (gated by isCommander(self nick); Maarten/Enforcer-Operator):
    ★MISSION (opens composer), ABORT # (prefill), HALT, RESUME
- Mission composer (commander only): N step rows [@agent + command], add/remove,
  auto id → sends `MISSION #m<seq> @a1 cmd | @a2 cmd | ...` (seq auto-increments).
- Non-commanders: commander chips hidden; manual typing still allowed but the
  conductor nick-gates server-side (correct).
- Exact wire formats from spec §4. Colours still TCL-driven (parseIrcColored).
- Phase C (future): push notifs on @mention/mission events, fallback host (orc
  100.104.200.124), SASL PLAIN, wss:7779, conductor AUTH/WHO commander listing.

### SWAT background-resilience DONE (Hermes Background-resilience.md)
- Bug: backgrounding app → JS suspended → WebSocket dies → Enforcer-Operator quits.
- Fix: (1) exponential-backoff reconnect 1s→60s (reset on IRC 001) + stale-socket
  onclose guard (no reconnect storm); (2) SwatTab AppState 'active' → immediate
  reconnect if intended-connected & down; (3) NATIVE Android foreground service
  + PARTIAL_WAKE_LOCK + persistent notification (LED-coloured, Disconnect action)
  keeps process/JS/WS alive in bg — plugins/withSwatBus.js + SwatBus{Module,
  Service,Package}.kt; perms FOREGROUND_SERVICE(+DATA_SYNC)/POST_NOTIFICATIONS/
  WAKE_LOCK/REQUEST_IGNORE_BATTERY_OPTIMIZATIONS. (4) 'keep alive in background'
  opt-in in SwatTab config → notif perm + battery-opt exemption.
- swatBus.ts = graceful no-op off-native. connect→busStart, disconnect→busStop,
  status change→busUpdate(notification).
- Verified: testing_agent 18/18 logic/regression pass (iteration_1.json); native
  FGS/wakelock = APK-only, on-device verify (bg 5min → still in roster).
- Fixed tester notes: emit() no longer rewinds state; stale onclose guarded.


### SWAT tab — Phase C (part 1): static ops, failover, SASL PLAIN
Scope this pass (push notifs = Phase C part 2, deferred — needs Firebase):
- **Commander list = STATIC, authorize-static / display-live** (`src/lib/swatOps.ts`):
  * `SWAT_OPS` is the app's shipped mirror of the sidecar `swat_ops` file
    (one nick per line). `isCommander()` now delegates to `isSwatOp()` — a
    local, case-insensitive check that NEVER hits the network. Deliberately no
    live conductor lookup (fail-closed trap: conductor down → locked out of
    ABORT). Display stays live (roster from NAMES, star chips). Added an `OPS`
    quick-verb that asks the conductor to ECHO its copy for drift-spotting
    (display only, never an auth input).
- **Fallback host + wss** (`swatIrc.ts`):
  * `SwatConfig` gained `fallbackHost`/`fallbackPort`/`tls`. `endpoints()`
    builds a [primary, fallback] ring (empties/dupes stripped); `endpointIdx++`
    on every failed `onclose`, so a stint on fallback is followed by a fresh
    primary re-probe. Scheme = `wss` when `tls` (listener :7779) else `ws`.
    NOTE: fallback is an operator-promoted recovery instance (Ergo can't
    federate), not automatic HA — see ergo-recovery-runbook.md.
- **SASL PLAIN** (`swatIrc.ts`): CAP LS 302 → REQ :sasl → AUTHENTICATE PLAIN →
  base64(`\0account\0password`) → 903 ok (CAP END → NICK/USER) / 90x fail
  (degrade: CAP END + register unauthenticated, surface error — never spin).
  Account in kv config; password in SecureStore only (`swat_sasl_password`).
  Gear panel gained fallback host/port, wss toggle, SASL account + secure pw.
  Hand-rolled UTF-8→base64 (Hermes has no reliable btoa).
- Verified: `tests/swat_logic.test.js` 30/30 (added SASL base64 cross-checked
  vs Node Buffer, failover ring, static-ops auth). WS connect / CAP-SASL
  handshake / gear UI = APK + live Ergo only (web preview can't bundle SQLite).

### SWAT tab — Phase C (part 2): OPS-echo panel + mention/mission alerts
- **OPS-echo drift panel** (`SwatTab.tsx` + `swatIrc.ts` `parseOpsEcho`):
  conductor's reply to the `OPS` verb (PRIVMSG/NOTICE like `OPS: a b` or
  `commanders = a, b`) is parsed into `state.opsEcho` and rendered as a
  dismissible panel above the feed. Chips are green when the nick is also in
  the app's shipped `SWAT_OPS`, amber+⚠ when conductor-only; a drift line
  lists app-only / conductor-only mismatches. Display/eyeball only — NEVER an
  authorization input.
- **@mention / MISSION / HALT alerts = LOCAL notifications** (no Firebase):
  * Native `SwatBus.notify(title, body, color)` (`SwatBusModule.kt`) posts a
    high-importance heads-up on a new `swat_alerts` channel, colour-accented
    (cyan mention / amber mission / red halt). Reuses existing POST_NOTIFICATIONS
    perm; no FCM / remote push — the live WS (kept alive by the FGS) feeds it.
  * `swatIrc.maybeAlert()` fires only while backgrounded (`AppState !=
    "active"`) and skips our own echoes. Mention = word-boundary/@nick regex;
    MISSION/HALT/ABORT by verb. Gated by new `alertsEnabled` config (default on,
    gear toggle).
- Verified: `tests/swat_logic.test.js` 40/40 (added OPS-echo parser + mention
  detection). Native notify + panel render = APK + live Ergo only.

### SWAT tab — Phase C (part 3): feedback pass (failover wiped, perms UX, wakelock toggle)
Operator on-device feedback after first APK build:
- **Failover WIPED** — Ergo can't federate; recovery = drop binary + restore
  ircd.yaml. Removed `fallbackHost`/`fallbackPort` from `SwatConfig`, the
  `endpoints()` ring + `endpointIdx`; `connectSwat` uses the single host again.
  wss:7779 toggle + SASL stay.
- **Permissions → real buttons + first-launch prompt** (`swatPerms.ts` + gear
  panel): killed the tiny blue blend-in line. New "keep-alive & permissions"
  group with clear status+action rows: 🔔 Notifications (fires the REAL
  `PermissionsAndroid.POST_NOTIFICATIONS` dialog on first launch; deep-links to
  settings when blocked), 🔋 Battery optimisation (FIX), 🔒 Wakelock. Status
  refreshes on app-resume.
- **Wakelock toggle replaces the nuking Disconnect** (`SwatBusService.kt` /
  `SwatBusModule.kt`): FGS no longer auto-acquires the wakelock — it's OFF by
  default (Kali-term style). The persistent notification's action button is now
  ACQUIRE ⇄ RELEASE WAKELOCK (ACTION_WAKE_ON/OFF/TOGGLE); Disconnect lives only
  on the in-app LED icon so the notification is never nuked. New JS bridges
  busSetWake/busToggleWake/busIsWakeHeld + gear toggle mirror the state.
- Deferred (operator's call): notification "0 online" roster count (busUpdate
  only fires on status change, not roster change), other minor UI.
- Verified: `tests/swat_logic.test.js` 36/36; tsc/lint clean. Native wakelock
  notification + runtime perm dialog = APK-only.

### Kali Term — terminal render/output bug pass (backlog dip)
Operator-supplied bug list (kalitermpoints.txt). Tier-1 fixes, Tier-2 chroot-
native pty daemon deferred by operator.
- **#1 STDERR DEATH** (`TerminalShell.tsx` shellInvocation): dropped
  `2>/dev/null` from the login shell — it nulled fd2 for the shell AND every
  child, silently swallowing `agy --help` / wifite errors. stderr is drained
  by its own native reader thread so it's safe to let through. Also switched
  `script -qc` → `script -qfc` (`-f` = per-write flush; without it script
  block-buffers ~4KB and short output feels stuck).
- **#3 HARDCODED SIZE LIES** (same line): removed `COLUMNS=120 LINES=40` — lied
  to every app (phone ≈50 cols). The fit→resize flow supplies real dims. (AITab
  keeps a fixed size on purpose for Rich.Live; documented the divergence.)
- **#2 EXIT-TAIL RACE** (`RootShellModule.kt` executeStream waiter): kept refs
  to both reader threads and `join(2000ms)` them AFTER `waitFor()` but BEFORE
  `flushSession`/EXIT/`sessions.remove()`, so trailing bytes from quick-exit
  commands aren't stranded in a removed session.
- **#4 RESIZE WIRING** — VERIFIED intact, no change: xterm `fit.fit()` →
  post({resize,cols,rows}) → onMessage → `sessionManager.resize` (dedupe) →
  `resizeSession` native `stty cols X rows Y` with echo-stripping. Real
  measured dims throughout.
- **Tier 2 (deferred)**: repackage enforcer-mcp sessions.py (openpty+TIOCSCTTY+
  setsid) as a WS endpoint on the chroot tail IP and swap TerminalShell's
  backend to it — real controlling tty, no script hack, no exit race by design.
- Verified: tsc/lint clean. Native su-pipe behaviour = APK-only.

### SSH backend mode — Phase 1 (native transport foundation) [DONE]
Strategic: make the Kali backend PLUGGABLE (chroot su-pipe OR SSH) to de-risk
the shrinking rooted-NetHunter device pool and support Kalidroid/Podroid VMs
(QEMU + USB passthrough → mon-mode/injection survive) and remote boxes.
Operator decisions: key-first auth (password too), ONE persistent SSH session
(true terminal, no oneshots), default host = tun0/tailscale0 IP, port 9922
(kali/podroid forward VM sshd:22 → 9922 on device IP), TOFU host keys, toggle =
FULL backend swap (not just terminal). Android-host-root features (overlay,
host su) stay su-only regardless.

Built this phase (all APK-only, cannot run in web/Expo Go):
- `plugins/android/SshShellModule.kt` — JSch (mwiede fork) transport mirroring
  RootShell's contract (executeStream/killSession/writeStdin/resizeSession +
  chunk/exit/error events). ONE persistent Session; empty cmd → ChannelShell
  (persistent login PTY = Terminal), non-empty → ChannelExec+PTY (tools/agents).
  Resize via real setPtySize (SIGWINCH — no stty hack, no `script`). TOFU:
  emits SshShell.hostkey fingerprint for JS store-on-first-use/warn.
- `plugins/android/SshShellPackage.kt`, `plugins/withSshShell.js` (adds
  com.github.mwiede:jsch:0.2.17 dep + proguard keeps + MainApplication reg),
  registered in app.json.
- `src/lib/sshBackend.ts` — JS wrapper mirroring rootShell.ts + connect/
  disconnect/isConnected + onSshState/onSshHostKey subscriptions.
- Non-breaking: chroot path untouched; nothing wired to it yet.

### SSH backend mode — Phase 2 (NEXT: selector + settings + Terminal)
- `src/lib/backend.ts` selector routing startStream/killStream/writeStdin/
  resizeSession + hasStreaming to chroot|ssh based on `exec_backend` config.
- Point `sessionManager.ts` import at backend.ts (rename hasNativeStreaming→
  hasStreaming).
- Backend-aware wrap/shell: `app/index.tsx` wrapForMode → identity in ssh mode;
  TerminalShell.shellInvocation → "" (bare login shell) in ssh mode.
- Settings: exec-backend toggle + SSH connection panel (host default =
  detectTailnetIp()/tun0, port 9922, user kali, auth key/pw, TOFU fingerprint
  store+warn). Password/private key in SecureStore. Connection status + reconnect.
  Reuse existing provisioning SSH key material (locate source).
- Phase 3: route AI + Live tabs through the selector (AI wrap backend-aware).

### SSH backend mode — Phase 2 (selector + settings + Terminal) [DONE]
Confirmed: S25U test target is STOCK (no root) — SSH path is fully root-
independent (connects over the network to Kalidroid's forwarded sshd). The
chroot-side key /root/.ssh/enforcer_cockpit is NOT used (wrong context); auth
is password (Kalidroid default kali/kali) or a pasted private key.
- `src/lib/backend.ts` — transport selector routing startStream/killStream/
  writeStdin/resizeSession/hasStreaming to chroot|ssh. Default chroot.
- `sessionManager.ts` now imports from backend.ts (hasNativeStreaming→hasStreaming).
- `src/lib/sshConfig.ts` — kv config (enabled/host/port/user/authMode/
  fingerprint) + password & key in SecureStore.
- `src/components/SshBackendPanel.tsx` — Settings panel: enable switch, host/
  port/user, PASSWORD|KEY toggle, secure fields, status dot, TOFU fingerprint,
  APPLY & CONNECT / DISCONNECT.
- `app/index.tsx` — backendKind state; wrapForMode → identity in ssh; SSH
  lifecycle (load config+secrets on mount, connect if enabled, onSshState/
  onSshHostKey subs with TOFU store+warn); renders SshBackendPanel; passes
  sshMode + execMode="kali" to TerminalShell when ssh.
- `TerminalShell.tsx` — sshMode prop: bypasses root/exec-mode gates (needs only
  HAS_NATIVE_SSH), shellInvocation()→"" (bare ChannelShell login PTY), writeStdin
  routed via backend.
- Build: main bundle 1369 modules, tsc/lint clean. APK-only to actually run.
- Phase 3 (next): route AI + Live tabs through the selector (treat ssh as non-
  mock, AI wrap backend-aware). Then tier-2 chroot-native pty daemon.

### SSH backend mode — Phase 3 (AI + Live tabs) [DONE]
Batched so ONE APK build validates the full SSH experience (Terminal+AI+Live).
- `AITab.tsx`: added `sshMode` prop — start gate requires HAS_NATIVE_SSH (not
  device root) when ssh; direct `writeStdin` (agent stdin) now routed via
  backend selector; imports HAS_NATIVE_SSH.
- `app/index.tsx`: AITab gets `execMode="kali"` + `sshMode` when ssh; LiveTab
  gets `execMode="kali"` when ssh so its `forceMock = execMode==="mock"` flips
  to real and streams route over ssh (wrap already identity in ssh mode).
- Both tabs already stream through sessionManager → backend selector, so no
  transport changes needed beyond the mock/root gating.
- Build: tsc/lint clean, bundle compiles (blank web = known SQLite-only).
- NOT covered (Phase 3b, if needed): dashboard runScan / quick-scan paths that
  still read raw execMode — left chroot-gated for now; the 3 tabs are the demo
  surface. Tier-2 chroot-native pty daemon still the next big pick.

### SSH backend mode — build fix (JSch resource clash)
EAS build failed: mergeReleaseJavaResource — duplicate
'META-INF/versions/9/OSGI-INF/MANIFEST.MF' from com.github.mwiede:jsch and its
transitive org.jspecify:jspecify. Fix in withSshShell.js: append an
`android { packaging { resources { excludes += [...OSGI MANIFEST...] } } }`
block to app/build.gradle (second android{} merges into the extension).
NOTE: icon.png / adaptive-icon.png are 1408x768 (non-square) — Expo warns but
build proceeds; NOT the failure. Left operator's branding untouched.

### SSH backend mode — MCP config.yaml sync over SSH [DONE]
Issue: MCP tab's handleChrootSync read config.yaml via busybox-chroot wrap +
HAS_NATIVE_ROOT gate → meaningless on stock S25U in SSH mode (no chroot).
Fix (JS-ONLY, no native rebuild of the SSH module needed):
- `sshBackend.ts`: added `execReal()` one-shot built on the existing native
  executeStream (ChannelExec) — buffers stdout, own base64→utf8 decoder.
- `backend.ts`: added `execReal()` to the selector.
- `MCPTab.tsx` handleChrootSync: when getActiveBackend()==="ssh" → require
  HAS_NATIVE_SSH (not root), run the RAW chroot_yaml_cmd (no wrap) via
  backendExecReal, strip \r (SSH PTY emits \r\n) before applyChrootYaml.
- Redis cloud roster pull confirmed working over SSH on-device (nodes green).
- NOTE for operator: SSH runs chroot_yaml_cmd VERBATIM inside Kali, so it must
  be a plain `cat /etc/enforcer-mcp/config.yaml` (no nethunter/nh wrapper).
- Reaches device via a fresh JS bundle → needs an APK rebuild, but NO native
  changes (existing SshShell module is compatible).

### MCP tab — editable bearer token + orientation
- Bug: cockpit bearer token was DISPLAY-ONLY (generate/import) → operator
  couldn't type/paste it. Fixed: editable TextInput bound to a local
  `bearerDraft`, committed on BLUR (not per-keystroke, to avoid restarting the
  health-probe loop). REVEAL toggles secureTextEntry; COPY/IMPORT/REGEN kept.
  Removed now-unused shortToken().
- Clarified "flicking switch wiped the redis token": NOT a wipe — patchConfig
  merges partial patches. Redis restores PER-NODE bearer tokens; the cockpit's
  own config.bearer_token is separate and was simply empty (hence the correct
  "token mismatch"). Editable field lets operator set it to match a node.
- Orientation: app.json "portrait" → "default" (landscape now supported —
  useful for the terminal). Needs a rebuild (native config); MCPTab change is
  JS. No native-module changes, so still a straightforward build.

### SWAT — registration-timeout fallback + mesh bearer editable (reminder)
- "Server Error: Registration timeout" is emitted by ERGO (server), not the
  app: WS connected but client never completed NICK/USER→001 in time. Prime
  suspect = SASL/CAP handshake stalling (Phase C). Fix: added `regTimer` — 9s
  after socket open, if 001 hasn't landed, force `CAP END` + `register()` so a
  stalled CAP can't hang us into the server's kill. Cleared on 001 / close /
  reconnect / disconnect. If timeout persists AFTER rebuild → it's the Ergo box
  (operator noted it has a tailnet/health problem), not the client.
- Mesh bearer editable fix (editable TextInput + bearerDraft/onBlur) is already
  in code from a prior turn — lands on next rebuild.

### SWAT — IRC-over-WS subprotocol fix (registration timeout)
Ergo log showed the S25U connecting from the phone's tail IP (100.114.63.84,
correct — SWAT WS runs on the Android host, not the VM) but never registering
→ "Registration timeout". Root cause: our WebSocket requested NO subprotocol,
so Ergo's ws listener accepted the socket but didn't parse NICK/USER as IRC.
Fix: `new WebSocket(url, ["text.ircv3.net"])` (IRCv3 WS subprotocol; one IRC
msg per UTF-8 text frame). Needs rebuild. If S10 runs IDENTICAL code and still
connects without it, look next at Ergo reverse-DNS/ident stall on that IP.
