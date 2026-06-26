/**
 * localDb — SQLite-backed local storage for Enforcer.
 *
 * Phase 4 expansion: all collections now live locally. Backend remains
 * as optional future sync target (swarm / MCP / backup) but the app no
 * longer DEPENDS on it for any core data path. Architecturally, the
 * "intermittent fetch fails → broken app" failure mode is eliminated.
 */

import * as SQLite from "expo-sqlite";

let _db: SQLite.SQLiteDatabase | null = null;
const TARGET_VERSION = 3;

export async function openLocalDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  const db = await SQLite.openDatabaseAsync("enforcer.db");
  await db.execAsync(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);
  await runMigrations(db);
  _db = db;
  return db;
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

export { kvGet, kvSet };
