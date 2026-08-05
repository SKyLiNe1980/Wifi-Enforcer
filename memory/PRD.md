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
