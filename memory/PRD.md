# Enforcer Cockpit — PRD / Change Log

Native (Android root-shell) Expo app + FastAPI `enforcer-mcp` backend for a
Tailscale-connected pentest node swarm. Nodes are mirrored to Upstash Redis
for reinstall recovery. NOTE: app is native-only (expo-sqlite + root shell);
it does NOT render in the web preview (expo-sqlite web worker crashes) — this
is expected and unrelated to feature work.

## Recent fixes

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
