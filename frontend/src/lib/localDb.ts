/**
 * localDb — SQLite-backed local storage for Enforcer.
 *
 * Phase 4 expansion: all collections now live locally. Backend remains
 * as optional future sync target (swarm / MCP / backup) but the app no
 * longer DEPENDS on it for any core data path. Architecturally, the
 * "intermittent fetch fails → broken app" failure mode is eliminated.
 *
 * Phase 5 (current build) adds the MCP tab schema (mcp_config, mcp_tools,
 * mcp_audit_log) — see migration v5 below. Crypto-secure bearer tokens
 * generated via expo-crypto in the MCPTab UI.
 */

import * as SQLite from "expo-sqlite";
import * as SecureStore from "expo-secure-store";

let _db: SQLite.SQLiteDatabase | null = null;
// ⚡ Single-flight promise — prevents the race where multiple callers
// (index.tsx, AITab, LiveTab all fire openLocalDb() during boot) each
// run the migration concurrently. Before this guard, every concurrent
// caller would: see _db===null → open a fresh handle → see user_version
// pre-migration → re-run the seed → insert 9 attack + 5 AI profiles AGAIN.
// With 8 concurrent callers that produced 72 attack profiles. Fun.
let _dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
const TARGET_VERSION = 13;

export async function openLocalDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  if (_dbPromise) return _dbPromise;
  _dbPromise = (async () => {
    const db = await SQLite.openDatabaseAsync("enforcer.db");
    await db.execAsync(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);
    await runMigrations(db);
    _db = db;
    return db;
  })();
  try {
    return await _dbPromise;
  } catch (e) {
    // Reset so a subsequent call can retry instead of getting a poisoned promise.
    _dbPromise = null;
    throw e;
  }
}

async function runMigrations(db: SQLite.SQLiteDatabase) {
  const result = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
  let current = result?.user_version ?? 0;
  while (current < TARGET_VERSION) {
    const next = current + 1;
    console.log(`[localDb] migrating ${current} → ${next}`);
    switch (next) {
      case 1:
        await db.execAsync(`
          CREATE TABLE IF NOT EXISTS kv (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `);
        break;
      case 2:
        // All resource tables. Each uses TEXT id (UUID4) to match backend
        // schema so a future sync can correlate rows trivially. JSON
        // blob columns (commands, etc.) stored as TEXT.
        await db.execAsync(`
          CREATE TABLE IF NOT EXISTS profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            commands TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS ai_profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            command TEXT NOT NULL,
            description TEXT DEFAULT '',
            wrap_mode TEXT DEFAULT 'none',
            send_newline INTEGER DEFAULT 1,
            send_initial TEXT,
            pre_command TEXT,
            icon TEXT DEFAULT '🤖',
            view_mode TEXT DEFAULT 'xterm',
            created_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS attack_profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            icon TEXT DEFAULT 'rocket-launch',
            category TEXT DEFAULT 'recon',
            command_template TEXT NOT NULL,
            needs_iface INTEGER DEFAULT 1,
            needs_endpoint INTEGER DEFAULT 0,
            needs_file INTEGER DEFAULT 0,
            view_mode TEXT DEFAULT 'scrollback',
            builtin INTEGER DEFAULT 0,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS pcap_endpoints (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            transport TEXT DEFAULT 'tcp',
            notes TEXT DEFAULT '',
            created_at TEXT NOT NULL
          );
        `);
        await seedDefaultsIfEmpty(db);
        break;
      case 3:
        // command_logs — used to be exclusively backend-hosted at
        // GET/DELETE /api/logs. Moving local so real/kali exec runs
        // (which previously skipped the backend entirely → never logged)
        // also gain a persistent transcript.
        await db.execAsync(`
          CREATE TABLE IF NOT EXISTS command_logs (
            id TEXT PRIMARY KEY,
            command TEXT NOT NULL,
            output TEXT DEFAULT '',
            exit_code INTEGER DEFAULT 0,
            duration_ms INTEGER DEFAULT 0,
            mocked INTEGER DEFAULT 0,
            timestamp TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_command_logs_ts ON command_logs(timestamp);
        `);
        break;
      case 4:
        // One-shot dedupe for users hit by the openLocalDb race (pre-fix
        // boots spawned N concurrent migrations, each seeding 9 attack +
        // 5 AI profiles, compounding on every cold launch). Keep the
        // oldest rowid per name; nuke the rest. Safe to run even on
        // pristine installs (no-op).
        await db.execAsync(`
          DELETE FROM attack_profiles WHERE rowid NOT IN (
            SELECT MIN(rowid) FROM attack_profiles GROUP BY name
          );
          DELETE FROM ai_profiles WHERE rowid NOT IN (
            SELECT MIN(rowid) FROM ai_profiles GROUP BY name
          );
          DELETE FROM profiles WHERE rowid NOT IN (
            SELECT MIN(rowid) FROM profiles GROUP BY name
          );
          DELETE FROM pcap_endpoints WHERE rowid NOT IN (
            SELECT MIN(rowid) FROM pcap_endpoints GROUP BY name
          );
        `);
        console.log(`[localDb] deduped profiles by name`);
        break;
      case 5:
        // MCP (Model Context Protocol) — Phase 1A scaffold.
        // Three tables: config (singleton row), tools registry,
        // audit log of every tool call (capped to 2000 entries via
        // append-time trim, like command_logs).
        //
        // Transport locked to HTTP+SSE; auth is bearer token.
        // server_enabled stays 0 until the user explicitly flips it —
        // we never want the cockpit to auto-expose an MCP endpoint.
        await db.execAsync(`
          CREATE TABLE IF NOT EXISTS mcp_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            server_enabled INTEGER DEFAULT 0,
            port INTEGER DEFAULT 8765,
            bind_host TEXT DEFAULT '127.0.0.1',
            bearer_token TEXT DEFAULT '',
            transport TEXT DEFAULT 'http_sse',
            require_token INTEGER DEFAULT 1,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS mcp_tools (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            description TEXT DEFAULT '',
            command_template TEXT NOT NULL,
            arg_schema_json TEXT DEFAULT '{}',
            wrap_mode TEXT DEFAULT 'auto',
            timeout_sec INTEGER DEFAULT 60,
            enabled INTEGER DEFAULT 1,
            built_in INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS mcp_audit_log (
            id TEXT PRIMARY KEY,
            ts TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            args_json TEXT DEFAULT '{}',
            result_summary TEXT DEFAULT '',
            client_id TEXT DEFAULT '',
            duration_ms INTEGER DEFAULT 0,
            exit_code INTEGER DEFAULT 0,
            success INTEGER DEFAULT 1
          );
          CREATE INDEX IF NOT EXISTS idx_mcp_audit_ts ON mcp_audit_log(ts);
          CREATE INDEX IF NOT EXISTS idx_mcp_audit_tool ON mcp_audit_log(tool_name);
        `);
        await seedMcpDefaults(db);
        break;
      case 6:
        // 1B.2a wiring: cockpit polls the chroot MCP server's /health
        // + /audit/since endpoints. Two schema additions:
        //   1. cockpit_probe_host on mcp_config — separate from bind_host
        //      because if the server binds ONLY to a tailnet IP (not 0.0.0.0
        //      or 127.0.0.1), loopback probes from the cockpit fail. This
        //      lets the operator override per-deploy.
        //   2. server_id on mcp_audit_log — the server's autoincrement
        //      integer id, used for dedupe when the cockpit polls
        //      /audit/since and gets overlapping rows. UUID id stays the
        //      primary key (cockpit-side identity).
        await db.execAsync(`
          ALTER TABLE mcp_config ADD COLUMN cockpit_probe_host TEXT DEFAULT '127.0.0.1';
          ALTER TABLE mcp_audit_log ADD COLUMN server_id INTEGER;
          CREATE INDEX IF NOT EXISTS idx_mcp_audit_server_id
            ON mcp_audit_log(server_id);
        `);
        break;
      case 7:
        // 1B.2b: cockpit auto-spawns the chroot MCP server on demand and
        // syncs its tool registry. Three schema additions:
        //   1. autospawn_enabled — opt-in switch (off by default; user
        //      explicitly turns it on after they've verified the chroot
        //      command works manually first).
        //   2. autospawn_cmd — the inner shell command (run *inside* the
        //      chroot). MCPTab prepends the existing settings.chroot_path
        //      (busybox_nh + chroot + sudo -E) at exec time so the command
        //      actually enters Kali. Defaults to just the `cd && python3`
        //      part — DO NOT default to `nethunter -c "..."` because that
        //      runs in the app's isolated namespace and can't see the
        //      bootkali mounts.
        //   3. mcp_tools.source — 'server' for entries upserted from the
        //      server's /tools endpoint, 'local' for hand-added ones.
        await db.execAsync(`
          ALTER TABLE mcp_config ADD COLUMN autospawn_enabled INTEGER DEFAULT 0;
          ALTER TABLE mcp_config ADD COLUMN autospawn_cmd TEXT
            DEFAULT '/opt/enforcer-mcp/.venv/bin/python /opt/enforcer-mcp/server.py --config /etc/enforcer-mcp/config.yaml';
          ALTER TABLE mcp_tools ADD COLUMN source TEXT DEFAULT 'local';
          ALTER TABLE mcp_tools ADD COLUMN last_synced_at TEXT;
        `);
        break;
      case 8:
        // Chroot-YAML auto-sync. EAS installs wipe local SQLite + sometimes
        // expo-secure-store, which means the bearer token + server bind/port
        // settings get reset to seed defaults on every fresh APK install.
        // The user's chroot /etc/enforcer-mcp/config.yaml is the source of
        // truth — instead of asking them to copy/paste the token every
        // time, we just shell out and read the YAML directly.
        //
        // IMPORTANT: We do NOT default to `nethunter -c "..."` here.
        // That command runs in the app's isolated mount namespace and
        // can't see the chroot mounts that bootkali set up at boot.
        // Instead we default to the literal inner command and let
        // wrapChrootCmd() in MCPTab prepend the existing
        // settings.chroot_path (the busybox_nh data_mirror incantation)
        // so the command actually enters the Kali filesystem.
        //
        //   chroot_yaml_cmd: the shell command (run *inside* the chroot)
        //     that prints the YAML to stdout. Default is just `cat …`
        //     because the wrapper prepends the chroot entry path.
        //   chroot_autosync_enabled: when true, MCPTab will run this on
        //     mount whenever the bearer token is empty (typical post-
        //     install state). On by default — the whole point of this
        //     feature is self-healing after install.
        await db.execAsync(`
          ALTER TABLE mcp_config ADD COLUMN chroot_yaml_cmd TEXT
            DEFAULT 'cat /etc/enforcer-mcp/config.yaml';
          ALTER TABLE mcp_config ADD COLUMN chroot_autosync_enabled INTEGER DEFAULT 1;
          ALTER TABLE mcp_config ADD COLUMN last_chroot_sync_at TEXT;
        `);
        break;
      case 9:
        // Patch-up for the previous EAS install: v8 shipped with
        // `nethunter -c "..."` defaults that DO NOT WORK because the
        // cockpit app runs in an isolated mount namespace and can't see
        // bootkali's chroot mounts (LineageOS data_mirror sandbox).
        //
        // The correct route is settings.chroot_path (busybox_nh + chroot
        // + sudo -E) which is already plumbed for other tabs. We rewrite
        // the offending defaults so they're just the *inner* command;
        // the cockpit's wrapChrootCmd() helper prepends the chroot_path
        // at exec time.
        //
        // We only touch rows that still look like the old bad default
        // — if the user has customised their command (e.g. added a
        // different YAML path), we leave it alone.
        await db.execAsync(`
          UPDATE mcp_config
            SET chroot_yaml_cmd = 'cat /etc/enforcer-mcp/config.yaml'
            WHERE chroot_yaml_cmd LIKE 'nethunter -c %';
          UPDATE mcp_config
            SET autospawn_cmd = 'cd /opt/enforcer-mcp && python3 server.py --config /etc/enforcer-mcp/config.yaml'
            WHERE autospawn_cmd LIKE 'nethunter -c %';
        `);
        break;
      case 10:
        // venv-aware autospawn. The previous default used `python3`
        // which resolves to the chroot's system Python — but our
        // dependencies (fastmcp, fastapi, uvicorn, jsonschema, yaml)
        // live inside the project venv at /opt/enforcer-mcp/.venv per
        // the README. Calling system python3 → instant
        // ModuleNotFoundError before the server even gets to argparse.
        //
        // Fix: call .venv/bin/python directly. Skips the `source
        // .venv/bin/activate` dance entirely (which is brittle in
        // non-interactive bash anyway) and gets the right interpreter
        // + sys.path in one shot. PATH inside the chroot is already
        // set by the sudo -E wrapper so other tools (airodump-ng etc.)
        // remain reachable.
        //
        // We only rewrite rows that still match the previous broken
        // default, so a user who manually adapted their autospawn_cmd
        // (e.g. to use a different venv, or no venv at all) is left
        // alone.
        await db.execAsync(`
          UPDATE mcp_config
            SET autospawn_cmd = '/opt/enforcer-mcp/.venv/bin/python /opt/enforcer-mcp/server.py --config /etc/enforcer-mcp/config.yaml'
            WHERE autospawn_cmd = 'cd /opt/enforcer-mcp && python3 server.py --config /etc/enforcer-mcp/config.yaml'
               OR autospawn_cmd LIKE 'cd /opt/enforcer-mcp && python3 %';
        `);
        break;
      case 11:
        // Phase 2 — multi-node swarm. The .deb is built; now the cockpit
        // needs to manage more than one MCP endpoint at a time. The local
        // chroot stays in mcp_config (no behavioural change there) — this
        // new table holds REMOTE nodes (VPS, Raspberry Pi, mini PCs over
        // Tailscale). Each node has its own bearer token + host + port +
        // tags + last-known health state.
        //
        // Design notes:
        //   • bearer_token is mirrored to SecureStore under a key derived
        //     from the node id (writeNodeBearerSecure / readNodeBearerSecure
        //     below). The SQLite column is a fallback only.
        //   • last_health_* fields are written by the per-node probe loop
        //     in MCPTab. Snapshotting them in SQLite means the // nodes
        //     view paints instantly on tab switch instead of waiting for
        //     the first probe of every node.
        //   • is_primary picks the node that the AI tab / Hermes loop will
        //     default to when no explicit node is selected. Enforced via
        //     setPrimary() (atomically clears the flag on all other rows).
        //   • UNIQUE(host, port) prevents accidental duplicates; the user
        //     would have to delete first to re-add.
        await db.execAsync(`
          CREATE TABLE IF NOT EXISTS mcp_nodes (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            host            TEXT NOT NULL,
            port            INTEGER NOT NULL DEFAULT 8765,
            bearer_token    TEXT DEFAULT '',
            transport       TEXT NOT NULL DEFAULT 'http_sse',
            enabled         INTEGER NOT NULL DEFAULT 1,
            is_primary      INTEGER NOT NULL DEFAULT 0,
            tags_json       TEXT NOT NULL DEFAULT '[]',
            description     TEXT DEFAULT '',
            last_seen_at    TEXT,
            last_health_status TEXT,
            last_health_info_json TEXT,
            last_tool_sync_at TEXT,
            last_tool_count INTEGER,
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL,
            UNIQUE (host, port)
          );
          CREATE INDEX IF NOT EXISTS idx_mcp_nodes_enabled
            ON mcp_nodes(enabled);
          CREATE INDEX IF NOT EXISTS idx_mcp_nodes_primary
            ON mcp_nodes(is_primary);
        `);
        break;
      case 12:
        // Phase 2b — remote node self-heal. When a provisioned remote node
        // goes unreachable for a sustained window, the cockpit SSHes in
        // (key-based, as root, using the keypair installed during the
        // Add-Node wizard) and restarts the service. Opt-in — off by
        // default so nobody's surprised by background SSH.
        await db.execAsync(`
          ALTER TABLE mcp_config ADD COLUMN remote_revive_enabled INTEGER DEFAULT 0;
        `);
        break;
      case 13:
        // Per-node SSH connection details so the cockpit can revive / manage
        // ANY node (not just wizard-provisioned ones). Older/hand-installed
        // nodes can now be given revive capability via Edit Node → Install
        // Revive Key. Defaults match the wizard (root@host:22).
        await db.execAsync(`
          ALTER TABLE mcp_nodes ADD COLUMN ssh_user TEXT DEFAULT 'root';
          ALTER TABLE mcp_nodes ADD COLUMN ssh_port INTEGER DEFAULT 22;
        `);
        break;
      default:
        throw new Error(`[localDb] no migration for version ${next}`);
    }
    await db.execAsync(`PRAGMA user_version = ${next}`);
    current = next;
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────
function uuid(): string {
  // RFC4122-ish v4 — good enough for local row IDs. Not cryptographic.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
const nowIso = () => new Date().toISOString();

async function kvGet<T = any>(key: string): Promise<T | null> {
  const db = await openLocalDb();
  const row = await db.getFirstAsync<{ value: string }>("SELECT value FROM kv WHERE key = ?", [key]);
  if (!row) return null;
  try { return JSON.parse(row.value) as T; } catch { return null; }
}
async function kvSet(key: string, value: any): Promise<void> {
  const db = await openLocalDb();
  await db.runAsync(
    "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)",
    [key, JSON.stringify(value), nowIso()],
  );
}

// ─── Settings ───────────────────────────────────────────────────────────
export type Settings = {
  exec_mode: "mock" | "real" | "kali";
  iface_a: string;
  iface_b: string;
  iface_c: string;
  country: string;
  active_iface: string;
  chroot_path: string;
};
const DEFAULT_SETTINGS: Settings = {
  exec_mode: "kali",
  iface_a: "wlan2",
  iface_b: "", iface_c: "",
  country: "US",
  active_iface: "A",
  chroot_path: "/data_mirror/data_ce/null/0/com.offsec.nethunter/scripts/bin/busybox_nh chroot /data/local/nhsystem/kalifs /usr/bin/sudo -E PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
};
export const settingsLocal = {
  async get(): Promise<Settings> {
    const stored = await kvGet<Partial<Settings>>("settings");
    return { ...DEFAULT_SETTINGS, ...(stored || {}) };
  },
  async update(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.get()), ...patch };
    await kvSet("settings", next);
    return next;
  },
  async clear(): Promise<void> {
    const db = await openLocalDb();
    await db.runAsync("DELETE FROM kv WHERE key = ?", ["settings"]);
  },
};

// ─── Wifi Profiles ──────────────────────────────────────────────────────
export type Profile = { id: string; name: string; description: string; commands: string[]; created_at: string };
export const profilesLocal = {
  async list(): Promise<Profile[]> {
    const db = await openLocalDb();
    const rows = await db.getAllAsync<any>("SELECT * FROM profiles ORDER BY created_at DESC");
    return rows.map((r) => ({ ...r, commands: JSON.parse(r.commands || "[]") }));
  },
  async create(p: Omit<Profile, "id" | "created_at">): Promise<Profile> {
    const db = await openLocalDb();
    const row = { id: uuid(), name: p.name, description: p.description || "", commands: p.commands || [], created_at: nowIso() };
    await db.runAsync(
      "INSERT INTO profiles (id, name, description, commands, created_at) VALUES (?, ?, ?, ?, ?)",
      [row.id, row.name, row.description, JSON.stringify(row.commands), row.created_at],
    );
    return row;
  },
  async delete(id: string): Promise<void> {
    const db = await openLocalDb();
    await db.runAsync("DELETE FROM profiles WHERE id = ?", [id]);
  },
};

// ─── AI Profiles ────────────────────────────────────────────────────────
export type AIProfile = {
  id: string; name: string; command: string; description: string;
  wrap_mode: "none" | "pty" | "unbuffered"; send_newline: boolean;
  send_initial: string | null; pre_command: string | null;
  icon: string; view_mode: "xterm" | "scrollback"; created_at: string;
};
export const aiProfilesLocal = {
  async list(): Promise<AIProfile[]> {
    const db = await openLocalDb();
    const rows = await db.getAllAsync<any>("SELECT * FROM ai_profiles ORDER BY created_at ASC");
    return rows.map((r) => ({ ...r, send_newline: !!r.send_newline }));
  },
  async upsert(p: Partial<AIProfile> & { id?: string; name: string; command: string }): Promise<AIProfile> {
    const db = await openLocalDb();
    const id = p.id || uuid();
    const existing = p.id ? await db.getFirstAsync<any>("SELECT * FROM ai_profiles WHERE id = ?", [id]) : null;
    const row: AIProfile = {
      id,
      name: p.name,
      command: p.command,
      description: p.description ?? existing?.description ?? "",
      wrap_mode: (p.wrap_mode ?? existing?.wrap_mode ?? "none") as any,
      send_newline: p.send_newline ?? (existing ? !!existing.send_newline : true),
      send_initial: p.send_initial ?? existing?.send_initial ?? null,
      pre_command: p.pre_command ?? existing?.pre_command ?? null,
      icon: p.icon ?? existing?.icon ?? "🤖",
      view_mode: (p.view_mode ?? existing?.view_mode ?? "xterm") as any,
      created_at: existing?.created_at ?? nowIso(),
    };
    await db.runAsync(
      `INSERT OR REPLACE INTO ai_profiles
       (id, name, command, description, wrap_mode, send_newline, send_initial, pre_command, icon, view_mode, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [row.id, row.name, row.command, row.description, row.wrap_mode, row.send_newline ? 1 : 0,
       row.send_initial, row.pre_command, row.icon, row.view_mode, row.created_at],
    );
    return row;
  },
  async delete(id: string): Promise<void> {
    const db = await openLocalDb();
    await db.runAsync("DELETE FROM ai_profiles WHERE id = ?", [id]);
  },
};

// ─── Attack Profiles ────────────────────────────────────────────────────
export type AttackProfile = {
  id: string; name: string; description: string; icon: string;
  category: "recon" | "attack" | "trace" | "pcap";
  command_template: string;
  needs_iface: boolean; needs_endpoint: boolean; needs_file: boolean;
  view_mode: "xterm" | "scrollback";
  builtin: boolean; sort_order: number; created_at: string;
};
export const attackProfilesLocal = {
  async list(): Promise<AttackProfile[]> {
    const db = await openLocalDb();
    const rows = await db.getAllAsync<any>("SELECT * FROM attack_profiles ORDER BY sort_order ASC, name ASC");
    return rows.map((r) => ({
      ...r,
      needs_iface: !!r.needs_iface, needs_endpoint: !!r.needs_endpoint, needs_file: !!r.needs_file,
      builtin: !!r.builtin,
    }));
  },
  async upsert(p: Partial<AttackProfile> & { id?: string; name: string; command_template: string }): Promise<AttackProfile> {
    const db = await openLocalDb();
    const id = p.id || uuid();
    const existing = p.id ? await db.getFirstAsync<any>("SELECT * FROM attack_profiles WHERE id = ?", [id]) : null;
    const row: AttackProfile = {
      id,
      name: p.name, command_template: p.command_template,
      description: p.description ?? existing?.description ?? "",
      icon: p.icon ?? existing?.icon ?? "rocket-launch",
      category: (p.category ?? existing?.category ?? "recon") as any,
      needs_iface: p.needs_iface ?? (existing ? !!existing.needs_iface : true),
      needs_endpoint: p.needs_endpoint ?? (existing ? !!existing.needs_endpoint : false),
      needs_file: p.needs_file ?? (existing ? !!existing.needs_file : false),
      view_mode: (p.view_mode ?? existing?.view_mode ?? "scrollback") as any,
      builtin: p.builtin ?? (existing ? !!existing.builtin : false),
      sort_order: p.sort_order ?? existing?.sort_order ?? 0,
      created_at: existing?.created_at ?? nowIso(),
    };
    await db.runAsync(
      `INSERT OR REPLACE INTO attack_profiles
       (id, name, description, icon, category, command_template, needs_iface, needs_endpoint, needs_file, view_mode, builtin, sort_order, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [row.id, row.name, row.description, row.icon, row.category, row.command_template,
       row.needs_iface ? 1 : 0, row.needs_endpoint ? 1 : 0, row.needs_file ? 1 : 0,
       row.view_mode, row.builtin ? 1 : 0, row.sort_order, row.created_at],
    );
    return row;
  },
  async delete(id: string): Promise<void> {
    const db = await openLocalDb();
    await db.runAsync("DELETE FROM attack_profiles WHERE id = ?", [id]);
  },
};

// ─── PCAP Endpoints ─────────────────────────────────────────────────────
export type PcapEndpoint = { id: string; name: string; host: string; port: number; transport: "tcp" | "udp"; notes: string; created_at: string };
export const pcapEndpointsLocal = {
  async list(): Promise<PcapEndpoint[]> {
    const db = await openLocalDb();
    return await db.getAllAsync<PcapEndpoint>("SELECT * FROM pcap_endpoints ORDER BY created_at ASC");
  },
  async upsert(e: Partial<PcapEndpoint> & { id?: string; name: string; host: string; port: number }): Promise<PcapEndpoint> {
    const db = await openLocalDb();
    const id = e.id || uuid();
    const existing = e.id ? await db.getFirstAsync<any>("SELECT * FROM pcap_endpoints WHERE id = ?", [id]) : null;
    const row: PcapEndpoint = {
      id, name: e.name, host: e.host, port: e.port,
      transport: (e.transport ?? existing?.transport ?? "tcp") as any,
      notes: e.notes ?? existing?.notes ?? "",
      created_at: existing?.created_at ?? nowIso(),
    };
    await db.runAsync(
      "INSERT OR REPLACE INTO pcap_endpoints (id, name, host, port, transport, notes, created_at) VALUES (?,?,?,?,?,?,?)",
      [row.id, row.name, row.host, row.port, row.transport, row.notes, row.created_at],
    );
    return row;
  },
  async delete(id: string): Promise<void> {
    const db = await openLocalDb();
    await db.runAsync("DELETE FROM pcap_endpoints WHERE id = ?", [id]);
  },
};

// ─── Seed defaults on first migration #2 run ────────────────────────────
// Hardcoded mirror of what the backend used to seed via Python. Keeps the
// app self-sufficient on cold install without any network round-trips.
async function seedDefaultsIfEmpty(db: SQLite.SQLiteDatabase) {
  const apCount = await db.getFirstAsync<{ c: number }>("SELECT COUNT(*) as c FROM attack_profiles");
  if ((apCount?.c ?? 0) === 0) {
    const seeds: Omit<AttackProfile, "id" | "created_at">[] = [
      { name: "airodump-ng", description: "live AP/STA scan — TUI table with signal strength, BSSIDs, channels", icon: "wifi-strength-4-alert", category: "recon", command_template: "airodump-ng {iface}", needs_iface: true, needs_endpoint: false, needs_file: false, view_mode: "xterm", builtin: true, sort_order: 10 },
      { name: "airodump → CSV", description: "capture to /sdcard/cap_<ts>.{csv,pcap} for offline analysis", icon: "file-table", category: "recon", command_template: "airodump-ng -w {file} --output-format csv,pcap {iface}", needs_iface: true, needs_endpoint: false, needs_file: true, view_mode: "scrollback", builtin: true, sort_order: 11 },
      { name: "wifite PMKID", description: "PMKID hash grab (no clients harmed) — kills NetworkManager first", icon: "key-variant", category: "attack", command_template: "wifite --pmkid --no-deauths --kill -i {iface}", needs_iface: true, needs_endpoint: false, needs_file: false, view_mode: "xterm", builtin: true, sort_order: 20 },
      { name: "wifite WPA", description: "full WPA handshake capture + auto-crack flow", icon: "shield-key", category: "attack", command_template: "wifite --wpa --kill -i {iface}", needs_iface: true, needs_endpoint: false, needs_file: false, view_mode: "xterm", builtin: true, sort_order: 21 },
      { name: "hcxdumptool", description: "PMKID + EAPOL capture (modern, faster than aircrack tools)", icon: "database-export", category: "attack", command_template: "hcxdumptool -i {iface} -o {file}.pcapng --enable_status=1", needs_iface: true, needs_endpoint: false, needs_file: true, view_mode: "scrollback", builtin: true, sort_order: 22 },
      { name: "tcpdump → file", description: "full packet capture to local /sdcard/tcpdump_<ts>.pcap", icon: "content-save", category: "trace", command_template: "tcpdump -i {iface} -w {file}.pcap -U", needs_iface: true, needs_endpoint: false, needs_file: true, view_mode: "scrollback", builtin: true, sort_order: 30 },
      { name: "PCAP → remote", description: "stream live packets to a remote Wireshark/NetworkMiner via nc", icon: "cloud-upload", category: "pcap", command_template: "tcpdump -i {iface} -U -w - | nc -w 3 {host} {port}", needs_iface: true, needs_endpoint: true, needs_file: false, view_mode: "scrollback", builtin: true, sort_order: 40 },
      { name: "iw event", description: "kernel wireless events — assoc/disassoc/auth/scan", icon: "console-network", category: "trace", command_template: "iw event -t", needs_iface: false, needs_endpoint: false, needs_file: false, view_mode: "scrollback", builtin: true, sort_order: 50 },
      { name: "dmesg -w", description: "follow kernel log — driver errors, firmware msgs", icon: "console-line", category: "trace", command_template: "dmesg -w", needs_iface: false, needs_endpoint: false, needs_file: false, view_mode: "scrollback", builtin: true, sort_order: 51 },
    ];
    for (const p of seeds) {
      await db.runAsync(
        `INSERT INTO attack_profiles (id, name, description, icon, category, command_template, needs_iface, needs_endpoint, needs_file, view_mode, builtin, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uuid(), p.name, p.description, p.icon, p.category, p.command_template,
         p.needs_iface ? 1 : 0, p.needs_endpoint ? 1 : 0, p.needs_file ? 1 : 0,
         p.view_mode, p.builtin ? 1 : 0, p.sort_order, nowIso()],
      );
    }
    console.log(`[localDb] seeded ${seeds.length} attack profiles`);
  }

  const aiCount = await db.getFirstAsync<{ c: number }>("SELECT COUNT(*) as c FROM ai_profiles");
  if ((aiCount?.c ?? 0) === 0) {
    const seeds: Omit<AIProfile, "id" | "created_at">[] = [
      { name: "Hermes", command: "hermes", description: "Nous Hermes (DeepSeek V4 Pro) — local agent with Textual TUI", wrap_mode: "pty", send_newline: true, send_initial: null, pre_command: "cd /root/.hermes && set -a && source ./.env 2>/dev/null; set +a", icon: "🜲", view_mode: "xterm" },
      { name: "CAI Framework", command: "cai", description: "Cybersecurity AI agent framework", wrap_mode: "pty", send_newline: true, send_initial: null, pre_command: null, icon: "🛡", view_mode: "xterm" },
      { name: "HEAVEN", command: "heaven", description: "HEAVEN multi-agent orchestrator", wrap_mode: "pty", send_newline: true, send_initial: null, pre_command: null, icon: "👁", view_mode: "xterm" },
      { name: "Pentagi", command: "pentagi", description: "Pentest agent (Pentagi)", wrap_mode: "pty", send_newline: true, send_initial: null, pre_command: null, icon: "🐉", view_mode: "xterm" },
      { name: "PentestAgent", command: "pentestagent", description: "Standalone pentest agent", wrap_mode: "pty", send_newline: true, send_initial: null, pre_command: null, icon: "🤖", view_mode: "xterm" },
    ];
    for (const p of seeds) {
      await db.runAsync(
        `INSERT INTO ai_profiles (id, name, command, description, wrap_mode, send_newline, send_initial, pre_command, icon, view_mode, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [uuid(), p.name, p.command, p.description, p.wrap_mode, p.send_newline ? 1 : 0,
         p.send_initial, p.pre_command, p.icon, p.view_mode, nowIso()],
      );
    }
    console.log(`[localDb] seeded ${seeds.length} AI profiles`);
  }
}

// ─── MCP Defaults ───────────────────────────────────────────────────────
// Seeds the singleton mcp_config row + an initial built-in tool registry
// matching the cockpit's existing primitives. Token starts EMPTY — the
// MCP tab UI generates one on first server enable to make sure we never
// ship a default-token APK that gets pwned. server_enabled also starts 0.
async function seedMcpDefaults(db: SQLite.SQLiteDatabase) {
  const cfgRow = await db.getFirstAsync<{ c: number }>("SELECT COUNT(*) as c FROM mcp_config");
  if ((cfgRow?.c ?? 0) === 0) {
    await db.runAsync(
      `INSERT INTO mcp_config (id, server_enabled, port, bind_host, bearer_token, transport, require_token, updated_at)
       VALUES (1, 0, 8765, '127.0.0.1', '', 'http_sse', 1, ?)`,
      [nowIso()],
    );
  }
  const toolCount = await db.getFirstAsync<{ c: number }>("SELECT COUNT(*) as c FROM mcp_tools");
  if ((toolCount?.c ?? 0) === 0) {
    // Built-in tool catalog — these become available to the MCP server
    // once Phase 1B lands. `command_template` uses {placeholder} tokens
    // that the server resolves from JSON-Schema-validated args. `wrap_mode:
    // auto` means the server picks chroot/su based on current exec_mode.
    const seeds = [
      {
        name: "exec_command",
        description: "Run a shell command on the cockpit host (root). Honors current exec_mode (Android su / Kali chroot).",
        command_template: "{cmd}",
        arg_schema_json: JSON.stringify({
          type: "object", required: ["cmd"],
          properties: { cmd: { type: "string", description: "Command line to execute" } },
        }),
        wrap_mode: "auto", timeout_sec: 60, built_in: 1,
      },
      {
        name: "read_command_logs",
        description: "Return the most recent command_logs entries from local SQLite (limit ≤ 200).",
        command_template: "__internal:read_command_logs",
        arg_schema_json: JSON.stringify({
          type: "object",
          properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
        }),
        wrap_mode: "none", timeout_sec: 5, built_in: 1,
      },
      {
        name: "list_ifaces",
        description: "List wireless interfaces and their current mode (managed/monitor) + channel.",
        command_template: "iw dev | awk '/Interface|type|channel/ {print}'",
        arg_schema_json: JSON.stringify({ type: "object", properties: {} }),
        wrap_mode: "auto", timeout_sec: 5, built_in: 1,
      },
      {
        name: "set_monitor_mode",
        description: "Put an interface into monitor mode via airmon-ng (use list_ifaces first to discover names).",
        command_template: "airmon-ng start {iface}",
        arg_schema_json: JSON.stringify({
          type: "object", required: ["iface"],
          properties: { iface: { type: "string", description: "Interface name e.g. wlan2" } },
        }),
        wrap_mode: "auto", timeout_sec: 15, built_in: 1,
      },
      {
        name: "set_channel",
        description: "Lock a monitor-mode interface to a specific channel.",
        command_template: "iw dev {iface} set channel {channel}",
        arg_schema_json: JSON.stringify({
          type: "object", required: ["iface", "channel"],
          properties: {
            iface: { type: "string" },
            channel: { type: "integer", minimum: 1, maximum: 196 },
          },
        }),
        wrap_mode: "auto", timeout_sec: 5, built_in: 1,
      },
      {
        name: "list_attack_profiles",
        description: "Return all attack profiles defined in the cockpit (name, description, command template).",
        command_template: "__internal:list_attack_profiles",
        arg_schema_json: JSON.stringify({ type: "object", properties: {} }),
        wrap_mode: "none", timeout_sec: 5, built_in: 1,
      },
      {
        name: "run_attack_profile",
        description: "Run a named attack profile against an iface (and optional file/endpoint args).",
        command_template: "__internal:run_attack_profile",
        arg_schema_json: JSON.stringify({
          type: "object", required: ["profile_name"],
          properties: {
            profile_name: { type: "string" },
            iface: { type: "string" },
            file: { type: "string" },
            host: { type: "string" }, port: { type: "integer" },
          },
        }),
        wrap_mode: "none", timeout_sec: 600, built_in: 1,
      },
      {
        name: "start_session",
        description: "Start a long-lived PTY session (e.g. Hermes, persistent shell). Returns session_id.",
        command_template: "__internal:start_session",
        arg_schema_json: JSON.stringify({
          type: "object", required: ["command"],
          properties: { command: { type: "string" }, label: { type: "string" } },
        }),
        wrap_mode: "none", timeout_sec: 10, built_in: 1,
      },
      {
        name: "write_stdin",
        description: "Send bytes to a running session's stdin (line by default ends with \\n).",
        command_template: "__internal:write_stdin",
        arg_schema_json: JSON.stringify({
          type: "object", required: ["session_id", "data"],
          properties: {
            session_id: { type: "string" },
            data: { type: "string" },
            newline: { type: "boolean", default: true },
          },
        }),
        wrap_mode: "none", timeout_sec: 5, built_in: 1,
      },
      {
        name: "read_session",
        description: "Read recent output from a session's ring buffer.",
        command_template: "__internal:read_session",
        arg_schema_json: JSON.stringify({
          type: "object", required: ["session_id"],
          properties: {
            session_id: { type: "string" },
            tail_bytes: { type: "integer", default: 4096, maximum: 65536 },
          },
        }),
        wrap_mode: "none", timeout_sec: 5, built_in: 1,
      },
      {
        name: "stop_session",
        description: "Kill a running session by id.",
        command_template: "__internal:stop_session",
        arg_schema_json: JSON.stringify({
          type: "object", required: ["session_id"],
          properties: { session_id: { type: "string" } },
        }),
        wrap_mode: "none", timeout_sec: 5, built_in: 1,
      },
    ];
    for (const t of seeds) {
      await db.runAsync(
        `INSERT INTO mcp_tools (id, name, description, command_template, arg_schema_json, wrap_mode, timeout_sec, enabled, built_in, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [uuid(), t.name, t.description, t.command_template, t.arg_schema_json, t.wrap_mode, t.timeout_sec, 1, t.built_in, nowIso()],
      );
    }
    console.log(`[localDb] seeded ${seeds.length} MCP tools`);
  }
}

// ─── Command Logs ───────────────────────────────────────────────────────
// Persisted history of every shell command executed via the Quick tab,
// runProfile(), or Terminal-classic input box. Replaces the obsolete
// backend `/api/logs` endpoint. Caps to 500 rows on append to keep the
// db lean (UI only renders the latest 200 anyway).
export type CommandLog = {
  id: string; command: string; output: string; exit_code: number;
  duration_ms: number; mocked: boolean; timestamp: string;
};
const LOG_CAP = 500;
export const commandLogsLocal = {
  async list(limit = 200): Promise<CommandLog[]> {
    const db = await openLocalDb();
    const rows = await db.getAllAsync<any>(
      "SELECT * FROM command_logs ORDER BY timestamp DESC LIMIT ?", [limit],
    );
    // Oldest-first for the terminal scrollback layout
    return rows.reverse().map((r) => ({ ...r, mocked: !!r.mocked }));
  },
  async append(l: Omit<CommandLog, "id" | "timestamp"> & { id?: string; timestamp?: string }): Promise<CommandLog> {
    const db = await openLocalDb();
    const row: CommandLog = {
      id: l.id || uuid(),
      command: l.command,
      output: l.output || "",
      exit_code: l.exit_code ?? 0,
      duration_ms: l.duration_ms ?? 0,
      mocked: !!l.mocked,
      timestamp: l.timestamp || nowIso(),
    };
    await db.runAsync(
      "INSERT INTO command_logs (id, command, output, exit_code, duration_ms, mocked, timestamp) VALUES (?,?,?,?,?,?,?)",
      [row.id, row.command, row.output, row.exit_code, row.duration_ms, row.mocked ? 1 : 0, row.timestamp],
    );
    // Trim — keep newest LOG_CAP rows. Cheap; SQLite handles it fast.
    await db.runAsync(
      `DELETE FROM command_logs WHERE id NOT IN (
         SELECT id FROM command_logs ORDER BY timestamp DESC LIMIT ?
       )`, [LOG_CAP],
    );
    return row;
  },
  async clear(): Promise<void> {
    const db = await openLocalDb();
    await db.runAsync("DELETE FROM command_logs");
  },
};

// ─── MCP (Model Context Protocol) ──────────────────────────────────────
// Cockpit-side data layer for the upcoming MCP server (Phase 1B).
// Phase 1A only wires the UI + persistence — the actual chroot-side
// FastMCP process gets spawned later. Everything is local SQLite so the
// MCP tab works offline / cold-boot just like the rest of the app.
//
// Bearer token storage: lives in expo-secure-store (AndroidKeyStore-backed
// EncryptedSharedPreferences on Android, iOS Keychain on iOS) rather than
// the SQLite mcp_config column. The SQLite column is kept as a legacy
// fallback for one-time migration from older builds. SecureStore advantages:
//   • Hardware-encrypted at rest
//   • Separate from the .db file, so an audit-log dump can't accidentally
//     leak the bearer
//   • Slightly more resilient across the various "clear data" paths
//
// IMPORTANT CAVEAT: NONE of this survives a full uninstall on Android —
// the OS wipes /data/data/{pkg}/ wholesale. If the user wants to retain
// the same token across reinstalls, they MUST copy it out (// status →
// REVEAL → COPY) before installing a new APK and paste it back after.
const SECURE_TOKEN_KEY = "mcp_bearer_token_v1";
async function readBearerSecure(): Promise<string | null> {
  try { return await SecureStore.getItemAsync(SECURE_TOKEN_KEY); } catch { return null; }
}
async function writeBearerSecure(token: string): Promise<void> {
  try {
    if (token) await SecureStore.setItemAsync(SECURE_TOKEN_KEY, token);
    else await SecureStore.deleteItemAsync(SECURE_TOKEN_KEY);
  } catch (e) {
    console.warn("[localDb] SecureStore write failed (token will live in sqlite only):", e);
  }
}
export type MCPConfig = {
  server_enabled: boolean; port: number; bind_host: string;
  cockpit_probe_host: string;
  bearer_token: string; transport: "http_sse" | "stdio";
  require_token: boolean;
  autospawn_enabled: boolean;
  autospawn_cmd: string;
  chroot_yaml_cmd: string;
  chroot_autosync_enabled: boolean;
  last_chroot_sync_at: string | null;
  remote_revive_enabled: boolean;
  updated_at: string;
};
export type MCPTool = {
  id: string; name: string; description: string;
  command_template: string; arg_schema_json: string;
  wrap_mode: "auto" | "kali" | "android" | "none";
  timeout_sec: number; enabled: boolean; built_in: boolean; created_at: string;
  source?: "local" | "server";
  last_synced_at?: string | null;
};
export type MCPAuditEntry = {
  id: string; ts: string; tool_name: string; args_json: string;
  result_summary: string; client_id: string; duration_ms: number;
  exit_code: number; success: boolean;
  server_id?: number | null;
};
const MCP_AUDIT_CAP = 2000;

export const mcpLocal = {
  async getConfig(): Promise<MCPConfig> {
    const db = await openLocalDb();
    const row = await db.getFirstAsync<any>("SELECT * FROM mcp_config WHERE id = 1");
    if (!row) {
      // Should never happen post-migration but defensive
      await db.runAsync(
        `INSERT INTO mcp_config (id, server_enabled, port, bind_host, bearer_token, transport, require_token, updated_at)
         VALUES (1, 0, 8765, '127.0.0.1', '', 'http_sse', 1, ?)`,
        [nowIso()],
      );
      return await this.getConfig();
    }
    // Token resolution order:
    //   1. SecureStore (preferred, hardware-encrypted)
    //   2. SQLite column (legacy / pre-secure-store builds)
    // If only SQLite has it, lazy-migrate into SecureStore now so future
    // reads use the secure path.
    let bearer = await readBearerSecure();
    if (!bearer && row.bearer_token) {
      bearer = row.bearer_token as string;
      // Lazy migrate: copy SQLite → SecureStore so the next read is hot.
      writeBearerSecure(bearer as string).catch(() => {});
    }
    return {
      ...row,
      bearer_token: bearer || "",
      cockpit_probe_host: row.cockpit_probe_host || "127.0.0.1",
      autospawn_enabled: !!row.autospawn_enabled,
      autospawn_cmd: row.autospawn_cmd || '/opt/enforcer-mcp/.venv/bin/python /opt/enforcer-mcp/server.py --config /etc/enforcer-mcp/config.yaml',
      chroot_yaml_cmd: row.chroot_yaml_cmd || 'cat /etc/enforcer-mcp/config.yaml',
      chroot_autosync_enabled: !!row.chroot_autosync_enabled,
      last_chroot_sync_at: row.last_chroot_sync_at || null,
      remote_revive_enabled: !!row.remote_revive_enabled,
      server_enabled: !!row.server_enabled,
      require_token: !!row.require_token,
    };
  },
  async updateConfig(patch: Partial<MCPConfig>): Promise<MCPConfig> {
    const db = await openLocalDb();
    const cur = await this.getConfig();
    const merged: MCPConfig = { ...cur, ...patch, updated_at: nowIso() };
    // Bearer token: write to SecureStore (source of truth). Also mirror to
    // SQLite column as a debug-/recovery-fallback that survives the rare
    // case where SecureStore unexpectedly fails to read back.
    if (patch.bearer_token !== undefined) {
      await writeBearerSecure(merged.bearer_token);
    }
    await db.runAsync(
      `UPDATE mcp_config SET server_enabled=?, port=?, bind_host=?, cockpit_probe_host=?,
        bearer_token=?, transport=?, require_token=?,
        autospawn_enabled=?, autospawn_cmd=?,
        chroot_yaml_cmd=?, chroot_autosync_enabled=?, last_chroot_sync_at=?,
        remote_revive_enabled=?,
        updated_at=? WHERE id = 1`,
      [
        merged.server_enabled ? 1 : 0,
        merged.port,
        merged.bind_host,
        merged.cockpit_probe_host || "127.0.0.1",
        merged.bearer_token,
        merged.transport,
        merged.require_token ? 1 : 0,
        merged.autospawn_enabled ? 1 : 0,
        merged.autospawn_cmd,
        merged.chroot_yaml_cmd,
        merged.chroot_autosync_enabled ? 1 : 0,
        merged.last_chroot_sync_at,
        merged.remote_revive_enabled ? 1 : 0,
        merged.updated_at,
      ],
    );
    return merged;
  },

  async listTools(): Promise<MCPTool[]> {
    const db = await openLocalDb();
    const rows = await db.getAllAsync<any>(
      "SELECT * FROM mcp_tools ORDER BY built_in DESC, name ASC",
    );
    return rows.map((r) => ({
      ...r,
      enabled: !!r.enabled,
      built_in: !!r.built_in,
    }));
  },
  async upsertTool(t: Partial<MCPTool> & { name: string; command_template: string }): Promise<MCPTool> {
    const db = await openLocalDb();
    if (t.id) {
      const cur = await db.getFirstAsync<any>("SELECT * FROM mcp_tools WHERE id = ?", [t.id]);
      if (cur) {
        const merged = { ...cur, ...t };
        await db.runAsync(
          `UPDATE mcp_tools SET name=?, description=?, command_template=?, arg_schema_json=?,
            wrap_mode=?, timeout_sec=?, enabled=? WHERE id=?`,
          [merged.name, merged.description || "", merged.command_template,
           merged.arg_schema_json || "{}", merged.wrap_mode || "auto",
           merged.timeout_sec ?? 60, merged.enabled !== false ? 1 : 0, t.id],
        );
        return { ...merged, enabled: !!merged.enabled, built_in: !!merged.built_in };
      }
    }
    const id = t.id || uuid();
    const row: MCPTool = {
      id,
      name: t.name,
      description: t.description || "",
      command_template: t.command_template,
      arg_schema_json: t.arg_schema_json || "{}",
      wrap_mode: (t.wrap_mode as any) || "auto",
      timeout_sec: t.timeout_sec ?? 60,
      enabled: t.enabled !== false,
      built_in: !!t.built_in,
      created_at: nowIso(),
    };
    await db.runAsync(
      `INSERT INTO mcp_tools (id, name, description, command_template, arg_schema_json, wrap_mode, timeout_sec, enabled, built_in, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [row.id, row.name, row.description, row.command_template, row.arg_schema_json,
       row.wrap_mode, row.timeout_sec, row.enabled ? 1 : 0, row.built_in ? 1 : 0, row.created_at],
    );
    return row;
  },
  async deleteTool(id: string): Promise<void> {
    const db = await openLocalDb();
    // Built-in tools can be disabled but not deleted — keeps the
    // restore-default path simple.
    await db.runAsync("DELETE FROM mcp_tools WHERE id = ? AND built_in = 0", [id]);
  },

  /**
   * Parse the chroot's /etc/enforcer-mcp/config.yaml (or whatever the
   * user's chroot_yaml_cmd returns) and patch our local mcp_config.
   *
   * Why this exists: every EAS install wipes SQLite + sometimes
   * SecureStore. The chroot YAML is the source of truth for the bearer
   * token, port, and bind host — there's no good reason to make the
   * user copy/paste them back into the cockpit on every install when
   * the cockpit has root shell access and can just read the file.
   *
   * We deliberately use a hand-rolled regex parser instead of pulling
   * `js-yaml` (5x app size hit for one file). The YAML we parse is
   * known-shape: a `server:` block with bearer_token_hex, port, host.
   * Anything else we ignore.
   *
   * Returns the keys that were actually changed so the UI can show
   * meaningful feedback ("imported token + port + host").
   */
  async applyChrootYaml(yamlText: string): Promise<{
    imported: string[];
    skipped: string[];
    raw: { bearer_token_hex?: string; port?: number; host?: string };
  }> {
    if (typeof yamlText !== "string" || !yamlText.trim()) {
      return { imported: [], skipped: ["empty"], raw: {} };
    }
    // Strip ANSI escape codes (in case the shell wrapped output through
    // a colorising pager like `bat` or `less -R`).
    const clean = yamlText.replace(/\u001b\[[0-9;]*m/g, "");
    // The fields we care about are nested under server: but the YAML
    // indentation depth varies (2 vs 4 spaces). Match anywhere the key
    // appears at the start of a line (after whitespace) followed by a
    // colon. Strip surrounding quotes off the value.
    const grab = (key: string): string | null => {
      const re = new RegExp(`^[\\t ]+${key}\\s*:\\s*([^\\r\\n#]+?)\\s*(?:#.*)?$`, "m");
      const m = clean.match(re);
      if (!m) return null;
      return m[1].replace(/^['"]|['"]$/g, "").trim();
    };
    const tok = grab("bearer_token_hex");
    const portS = grab("port");
    const host = grab("host");

    const raw = {
      bearer_token_hex: tok || undefined,
      port: portS && /^\d+$/.test(portS) ? Number(portS) : undefined,
      host: host || undefined,
    };

    const patch: Partial<MCPConfig> = { last_chroot_sync_at: nowIso() };
    const imported: string[] = [];
    const skipped: string[] = [];

    if (raw.bearer_token_hex && /^[0-9a-f]{16,}$/i.test(raw.bearer_token_hex)) {
      patch.bearer_token = raw.bearer_token_hex.toLowerCase();
      imported.push("bearer_token");
    } else if (tok) {
      skipped.push("bearer_token (bad format)");
    }

    if (raw.port && raw.port > 0 && raw.port < 65536) {
      patch.port = raw.port;
      imported.push("port");
    } else if (portS) {
      skipped.push("port (out of range)");
    }

    if (raw.host && raw.host.length <= 64) {
      // Accept 0.0.0.0, 127.0.0.1, tailnet IPs, hostnames — anything that
      // isn't obviously a URL or path.
      if (!/[/\s]/.test(raw.host) && !raw.host.startsWith("http")) {
        patch.bind_host = raw.host;
        imported.push("bind_host");
        // ── Mirror the imported host into cockpit_probe_host ──────────
        // On a fresh reinstall SQLite is wiped and cockpit_probe_host
        // seeds back to the loopback default (127.0.0.1). Because this
        // is a tailnet-mesh app the probe target should track the
        // server's real bind IP, not loopback — otherwise the cockpit
        // probes localhost and lists the node as UNREACH. We ONLY do
        // this when the operator hasn't deliberately set a probe host
        // (current value is still the loopback default) AND the imported
        // host is a routable address (not loopback / wildcard, which
        // can't be probed directly).
        const cur = await this.getConfig();
        const curProbe = (cur.cockpit_probe_host || "").trim();
        const isProbeDefault = curProbe === "" || curProbe === "127.0.0.1";
        const isRoutable = raw.host !== "127.0.0.1" && raw.host !== "0.0.0.0";
        if (isProbeDefault && isRoutable) {
          patch.cockpit_probe_host = raw.host;
          imported.push("cockpit_probe_host");
        }
      } else {
        skipped.push("host (unexpected chars)");
      }
    }

    if (imported.length > 0) {
      await this.updateConfig(patch);
    }
    return { imported, skipped, raw };
  },

  /**
   * Bulk-upsert tool definitions pulled from the chroot server's
   * GET /tools endpoint. Idempotent: keyed by `name` (which has a UNIQUE
   * constraint), so re-running just refreshes descriptions / schemas /
   * timeouts. Server-sourced tools get `source='server'` and `built_in=1`
   * so they can't be accidentally deleted from the UI. Existing
   * `enabled` flags are PRESERVED across syncs — disabling a tool in
   * the cockpit shouldn't be undone by the next refresh.
   *
   * Returns counts so the UI can show "+3 new, 5 updated" feedback.
   */
  async syncToolsFromServer(serverTools: {
    name: string; description?: string; command_template?: string;
    arg_schema?: any; arg_schema_json?: string;
    wrap_mode?: string; timeout_sec?: number;
    internal?: boolean;
  }[]): Promise<{ inserted: number; updated: number; total: number }> {
    if (!Array.isArray(serverTools)) return { inserted: 0, updated: 0, total: 0 };
    const db = await openLocalDb();
    const ts = nowIso();
    let inserted = 0;
    let updated = 0;
    for (const t of serverTools) {
      if (!t || typeof t.name !== "string" || !t.name.trim()) continue;
      const name = t.name.trim();
      const schemaJson = t.arg_schema_json ?? JSON.stringify(t.arg_schema ?? {});
      const cmd = t.command_template || "";
      const desc = t.description || "";
      const wrap = (t.wrap_mode as any) || "none";
      const timeout = t.timeout_sec ?? 60;
      const existing = await db.getFirstAsync<{ id: string; enabled: number }>(
        "SELECT id, enabled FROM mcp_tools WHERE name = ?", [name],
      );
      if (existing) {
        // Refresh definition. Preserve enabled flag (user's choice trumps server).
        await db.runAsync(
          `UPDATE mcp_tools
             SET description=?, command_template=?, arg_schema_json=?,
                 wrap_mode=?, timeout_sec=?, source='server',
                 built_in=1, last_synced_at=?
           WHERE id=?`,
          [desc, cmd, schemaJson, wrap, timeout, ts, existing.id],
        );
        updated++;
      } else {
        await db.runAsync(
          `INSERT INTO mcp_tools
             (id, name, description, command_template, arg_schema_json,
              wrap_mode, timeout_sec, enabled, built_in,
              source, last_synced_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [uuid(), name, desc, cmd, schemaJson, wrap, timeout,
           1, 1, "server", ts, ts],
        );
        inserted++;
      }
    }
    const totalRow = await db.getFirstAsync<{ c: number }>(
      "SELECT COUNT(*) as c FROM mcp_tools",
    );
    return { inserted, updated, total: totalRow?.c ?? 0 };
  },

  async listAudit(limit = 200): Promise<MCPAuditEntry[]> {
    const db = await openLocalDb();
    const rows = await db.getAllAsync<any>(
      "SELECT * FROM mcp_audit_log ORDER BY ts DESC LIMIT ?", [limit],
    );
    return rows.map((r) => ({ ...r, success: !!r.success }));
  },
  async appendAudit(e: Omit<MCPAuditEntry, "id" | "ts"> & { id?: string; ts?: string }): Promise<MCPAuditEntry> {
    const db = await openLocalDb();
    const row: MCPAuditEntry = {
      id: e.id || uuid(),
      ts: e.ts || nowIso(),
      tool_name: e.tool_name,
      args_json: e.args_json || "{}",
      result_summary: e.result_summary || "",
      client_id: e.client_id || "",
      duration_ms: e.duration_ms ?? 0,
      exit_code: e.exit_code ?? 0,
      success: !!e.success,
      server_id: e.server_id ?? null,
    };
    await db.runAsync(
      `INSERT INTO mcp_audit_log (id, ts, tool_name, args_json, result_summary, client_id, duration_ms, exit_code, success, server_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [row.id, row.ts, row.tool_name, row.args_json, row.result_summary,
       row.client_id, row.duration_ms, row.exit_code, row.success ? 1 : 0,
       row.server_id ?? null],
    );
    await db.runAsync(
      `DELETE FROM mcp_audit_log WHERE id NOT IN (
         SELECT id FROM mcp_audit_log ORDER BY ts DESC LIMIT ?
       )`, [MCP_AUDIT_CAP],
    );
    return row;
  },
  async clearAudit(): Promise<void> {
    const db = await openLocalDb();
    await db.runAsync("DELETE FROM mcp_audit_log");
  },

  /**
   * Largest server_id we've already mirrored locally. Used as the cursor
   * for /audit/since polls — server returns rows with ts > cursor, but the
   * ts cursor alone has a millisecond-collision risk under burst load, so
   * we additionally filter inserts by server_id presence.
   */
  async getMaxServerAuditId(): Promise<number | null> {
    const db = await openLocalDb();
    const row = await db.getFirstAsync<{ max_id: number | null }>(
      "SELECT MAX(server_id) as max_id FROM mcp_audit_log WHERE server_id IS NOT NULL",
    );
    return row?.max_id ?? null;
  },
  async getMaxAuditTs(): Promise<string | null> {
    const db = await openLocalDb();
    const row = await db.getFirstAsync<{ max_ts: string | null }>(
      "SELECT MAX(ts) as max_ts FROM mcp_audit_log",
    );
    return row?.max_ts ?? null;
  },

  /**
   * Bulk-ingest events pulled from /audit/since. Each event must carry a
   * numeric `id` (server-side autoincrement) which we store as `server_id`
   * to dedupe across repeated polls. Returns count of NEWLY inserted rows.
   */
  async syncAuditFromServer(events: {
    id: number; ts: string; tool_name: string;
    args?: any; args_json?: string;
    result_summary?: string; client_id?: string;
    client?: string; source?: string; remote_addr?: string; peer?: string; ip?: string;
    duration_ms?: number; exit_code?: number; success?: boolean;
  }[], sourceHost?: string): Promise<number> {
    if (!events.length) return 0;
    const db = await openLocalDb();
    // Pre-fetch already-known server_ids to skip duplicates without
    // hammering the unique constraint with INSERT-then-rollback churn.
    const ids = events.map((e) => e.id).filter((n) => typeof n === "number");
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const known = await db.getAllAsync<{ server_id: number }>(
      `SELECT server_id FROM mcp_audit_log WHERE server_id IN (${placeholders})`,
      ids,
    );
    const knownSet = new Set(known.map((k) => k.server_id));
    let inserted = 0;
    for (const e of events) {
      if (knownSet.has(e.id)) continue;
      const args_json = e.args_json ?? JSON.stringify(e.args ?? {});
      // Source resolution: prefer any of the field names the server may use;
      // fall back to the host we polled the audit from so the log ALWAYS
      // shows a source/IP instead of "(unknown)".
      const src =
        (e.client_id || e.client || e.source || e.remote_addr || e.peer || e.ip || "").trim() ||
        (sourceHost || "");
      await db.runAsync(
        `INSERT INTO mcp_audit_log (id, ts, tool_name, args_json, result_summary, client_id, duration_ms, exit_code, success, server_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          uuid(), e.ts, e.tool_name, args_json,
          e.result_summary || "", src,
          e.duration_ms ?? 0, e.exit_code ?? 0,
          e.success === false ? 0 : 1, e.id,
        ],
      );
      inserted++;
    }
    if (inserted > 0) {
      // Trim to cap once after the batch insert
      await db.runAsync(
        `DELETE FROM mcp_audit_log WHERE id NOT IN (
           SELECT id FROM mcp_audit_log ORDER BY ts DESC LIMIT ?
         )`, [MCP_AUDIT_CAP],
      );
    }
    return inserted;
  },
};

// ─── Per-node bearer storage ─────────────────────────────────────────
// Each remote node has its own bearer token (the .deb postinst generates
// a fresh one per install). We mirror tokens to SecureStore keyed by
// node id so they survive `clear-data` and aren't visible in plaintext
// SQLite dumps. SQLite column is fallback only.
const NODE_SECURE_PREFIX = "enforcer.mcp.node.bearer.";

async function readNodeBearerSecure(nodeId: string): Promise<string | null> {
  try { return await SecureStore.getItemAsync(NODE_SECURE_PREFIX + nodeId); }
  catch { return null; }
}
async function writeNodeBearerSecure(nodeId: string, token: string): Promise<void> {
  try {
    if (token) await SecureStore.setItemAsync(NODE_SECURE_PREFIX + nodeId, token);
    else await SecureStore.deleteItemAsync(NODE_SECURE_PREFIX + nodeId);
  } catch { /* mirror-only; SQLite has the source of truth fallback */ }
}

// ─── Types ──────────────────────────────────────────────────────────
export type MCPNode = {
  id: string;
  name: string;
  host: string;
  port: number;
  bearer_token: string;
  transport: "http_sse" | "stdio";
  enabled: boolean;
  is_primary: boolean;
  tags: string[];
  description: string;
  ssh_user: string;
  ssh_port: number;
  last_seen_at: string | null;
  last_health_status: string | null;
  last_health_info: Record<string, unknown> | null;
  last_tool_sync_at: string | null;
  last_tool_count: number | null;
  created_at: string;
  updated_at: string;
};

type NodeRow = {
  id: string; name: string; host: string; port: number;
  bearer_token: string; transport: string;
  enabled: number; is_primary: number;
  tags_json: string; description: string;
  ssh_user: string | null; ssh_port: number | null;
  last_seen_at: string | null;
  last_health_status: string | null;
  last_health_info_json: string | null;
  last_tool_sync_at: string | null;
  last_tool_count: number | null;
  created_at: string; updated_at: string;
};

function rowToNode(row: NodeRow, bearerFromSecure?: string | null): MCPNode {
  let tags: string[] = [];
  try { tags = JSON.parse(row.tags_json || "[]"); }
  catch { tags = []; }
  let healthInfo: Record<string, unknown> | null = null;
  if (row.last_health_info_json) {
    try { healthInfo = JSON.parse(row.last_health_info_json); }
    catch { healthInfo = null; }
  }
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    // SecureStore is the source of truth; fall back to SQLite column on miss.
    bearer_token: bearerFromSecure ?? row.bearer_token ?? "",
    transport: (row.transport as "http_sse" | "stdio") || "http_sse",
    enabled: !!row.enabled,
    is_primary: !!row.is_primary,
    tags,
    description: row.description || "",
    ssh_user: row.ssh_user || "root",
    ssh_port: row.ssh_port ?? 22,
    last_seen_at: row.last_seen_at,
    last_health_status: row.last_health_status,
    last_health_info: healthInfo,
    last_tool_sync_at: row.last_tool_sync_at,
    last_tool_count: row.last_tool_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ─── nodesLocal — multi-node management ─────────────────────────────
// Phase 2: each remote MCP endpoint (VPS, Pi, mini-PC swarm node) gets
// its own row here. The cockpit's local chroot keeps using mcp_config
// so existing UI continues to work unchanged.
export const nodesLocal = {
  async list(): Promise<MCPNode[]> {
    const db = await openLocalDb();
    const rows = await db.getAllAsync<NodeRow>(
      `SELECT * FROM mcp_nodes ORDER BY is_primary DESC, created_at ASC`,
    );
    // Hydrate bearers from SecureStore in parallel (one round-trip each
    // but they're tiny + run concurrently).
    return Promise.all(rows.map(async (r) =>
      rowToNode(r, await readNodeBearerSecure(r.id))));
  },

  async get(id: string): Promise<MCPNode | null> {
    const db = await openLocalDb();
    const row = await db.getFirstAsync<NodeRow>(
      `SELECT * FROM mcp_nodes WHERE id = ?`, [id]);
    if (!row) return null;
    return rowToNode(row, await readNodeBearerSecure(id));
  },

  async create(input: {
    name: string; host: string; port?: number;
    bearer_token?: string; transport?: "http_sse" | "stdio";
    enabled?: boolean; is_primary?: boolean;
    tags?: string[]; description?: string;
    ssh_user?: string; ssh_port?: number;
  }): Promise<MCPNode> {
    const db = await openLocalDb();
    const id = uuid();
    const ts = nowIso();
    const node: MCPNode = {
      id, name: input.name.trim() || "node",
      host: input.host.trim(),
      port: input.port ?? 8765,
      bearer_token: input.bearer_token || "",
      transport: input.transport || "http_sse",
      enabled: input.enabled ?? true,
      is_primary: input.is_primary ?? false,
      tags: input.tags || [],
      description: input.description || "",
      ssh_user: input.ssh_user || "root",
      ssh_port: input.ssh_port ?? 22,
      last_seen_at: null,
      last_health_status: null,
      last_health_info: null,
      last_tool_sync_at: null,
      last_tool_count: null,
      created_at: ts, updated_at: ts,
    };
    // If this is the first node, force is_primary=true so something is
    // always the default target.
    const countRow = await db.getFirstAsync<{ c: number }>(
      "SELECT COUNT(*) as c FROM mcp_nodes");
    if ((countRow?.c ?? 0) === 0) node.is_primary = true;

    await db.runAsync(
      `INSERT INTO mcp_nodes
        (id, name, host, port, bearer_token, transport, enabled, is_primary,
         tags_json, description, ssh_user, ssh_port, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [node.id, node.name, node.host, node.port, node.bearer_token,
       node.transport, node.enabled ? 1 : 0, node.is_primary ? 1 : 0,
       JSON.stringify(node.tags), node.description,
       node.ssh_user, node.ssh_port,
       node.created_at, node.updated_at],
    );
    await writeNodeBearerSecure(id, node.bearer_token);
    if (node.is_primary) await this.setPrimary(id);
    return node;
  },

  async update(id: string, patch: Partial<MCPNode>): Promise<MCPNode> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`unknown node: ${id}`);
    const db = await openLocalDb();
    const merged: MCPNode = { ...cur, ...patch, updated_at: nowIso() };
    if (patch.bearer_token !== undefined) {
      await writeNodeBearerSecure(id, merged.bearer_token);
    }
    await db.runAsync(
      `UPDATE mcp_nodes SET
         name=?, host=?, port=?, bearer_token=?, transport=?, enabled=?,
         tags_json=?, description=?, ssh_user=?, ssh_port=?, updated_at=?
       WHERE id=?`,
      [merged.name, merged.host, merged.port, merged.bearer_token,
       merged.transport, merged.enabled ? 1 : 0,
       JSON.stringify(merged.tags), merged.description,
       merged.ssh_user, merged.ssh_port,
       merged.updated_at, id],
    );
    // is_primary is managed via setPrimary() (atomic) — patch.is_primary
    // here is intentionally ignored to avoid two-primary races.
    return merged;
  },

  async setPrimary(id: string): Promise<void> {
    const db = await openLocalDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync(`UPDATE mcp_nodes SET is_primary = 0`);
      await db.runAsync(`UPDATE mcp_nodes SET is_primary = 1 WHERE id = ?`, [id]);
    });
  },

  async delete(id: string): Promise<void> {
    const db = await openLocalDb();
    await db.runAsync(`DELETE FROM mcp_nodes WHERE id = ?`, [id]);
    await writeNodeBearerSecure(id, "");
    // If we just deleted the primary, promote the oldest remaining row.
    const remaining = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM mcp_nodes WHERE is_primary = 1 LIMIT 1`);
    if (!remaining) {
      const first = await db.getFirstAsync<{ id: string }>(
        `SELECT id FROM mcp_nodes ORDER BY created_at ASC LIMIT 1`);
      if (first) await this.setPrimary(first.id);
    }
  },

  /**
   * Write a health-probe snapshot back to SQLite so the // nodes view
   * paints instantly on tab switch instead of waiting for the first
   * probe of every node.
   *
   * Status values mirror the existing MCPTab probe state machine:
   *   "running" | "unreachable" | "error" | "unknown"
   */
  async updateHealth(id: string, snapshot: {
    status: string;
    info?: Record<string, unknown> | null;
    tool_count?: number | null;
  }): Promise<void> {
    const db = await openLocalDb();
    await db.runAsync(
      `UPDATE mcp_nodes SET
         last_seen_at = ?,
         last_health_status = ?,
         last_health_info_json = ?,
         last_tool_count = COALESCE(?, last_tool_count),
         updated_at = ?
       WHERE id = ?`,
      [nowIso(), snapshot.status,
       snapshot.info ? JSON.stringify(snapshot.info) : null,
       snapshot.tool_count ?? null,
       nowIso(), id],
    );
  },

  async markToolSync(id: string, toolCount: number): Promise<void> {
    const db = await openLocalDb();
    await db.runAsync(
      `UPDATE mcp_nodes SET last_tool_sync_at = ?, last_tool_count = ?
       WHERE id = ?`, [nowIso(), toolCount, id]);
  },

  /**
   * Idempotent create-or-update keyed on (host, port). Used by tailnet
   * peer discovery restore: we want to re-add every enforcer node found
   * on the tailscale mesh without duplicating rows the operator already
   * has for the same IP.
   *
   * If a row with the same host+port exists → update its bearer_token,
   * name, tags, description and re-enable it. Otherwise fall through to
   * a normal create().
   */
  async upsert(input: {
    name: string; host: string; port?: number;
    bearer_token?: string; transport?: "http_sse" | "stdio";
    enabled?: boolean; is_primary?: boolean;
    tags?: string[]; description?: string;
    ssh_user?: string; ssh_port?: number;
  }): Promise<MCPNode> {
    const db = await openLocalDb();
    const port = input.port ?? 8765;
    const existing = await db.getFirstAsync<NodeRow>(
      `SELECT * FROM mcp_nodes WHERE host = ? AND port = ? LIMIT 1`,
      [input.host.trim(), port],
    );
    if (existing) {
      return this.update(existing.id, {
        name: input.name.trim() || existing.name,
        bearer_token: input.bearer_token || existing.bearer_token,
        transport: input.transport || (existing.transport as any),
        enabled: input.enabled ?? true,
        tags: input.tags ?? [],
        description: input.description ?? existing.description ?? "",
        ...(input.ssh_user ? { ssh_user: input.ssh_user } : {}),
        ...(input.ssh_port ? { ssh_port: input.ssh_port } : {}),
      });
    }
    return this.create({ ...input, port });
  },
};
export { kvGet, kvSet };
