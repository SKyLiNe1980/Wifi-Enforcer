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
