/**
 * localDb — SQLite-backed local storage for Enforcer.
 *
 * Replaces the previous "everything via /api fetch" architecture with
 * device-local persistence. Rationale:
 *
 *   • An operator security tool must work offline, on captive Wi-Fi, in
 *     airplane mode, on networks that intercept HTTPS. Fetch-based state
 *     bricked the app every time the user's connection had a hiccup.
 *   • The Emergent platform routes all backend traffic through Cloudflare,
 *     which intermittently challenges RN's fetch fingerprint. Even with
 *     headers + retry + body-preview diagnostics, the underlying
 *     fragility remained — we were hardening symptoms, not the cause.
 *   • Settings / profiles / logs are inherently per-device anyway. The
 *     backend was a remote source of truth for data that has no reason
 *     to live remotely.
 *
 * Architecture (hybrid):
 *   sqlite = canonical local store (all reads, all writes)
 *   backend = optional sync target (future: push for backup / pull from
 *             other swarm nodes via Tailscale; not in this phase)
 *
 * Phase 1 (this file): settings only. Other tables (profiles, AI
 * profiles, attack profiles, PCAP endpoints, logs) follow in next
 * session — same pattern, just more tables.
 */

import * as SQLite from "expo-sqlite";

// Single global handle — opening sqlite is cheap but we don't need
// multiple connections. `openDatabaseAsync` is the modern (SDK 51+) API;
// the older sync `openDatabase` is deprecated.
let _db: SQLite.SQLiteDatabase | null = null;

/**
 * Lazily opens (and migrates) the local DB. Idempotent — safe to call
 * from multiple components on mount; they all share the same handle.
 *
 * Migrations are tracked via PRAGMA user_version. To add a new migration:
 *   1. Bump TARGET_VERSION below
 *   2. Add a case in the switch covering the next version step
 *   3. Each case should be idempotent (CREATE TABLE IF NOT EXISTS, etc.)
 */
const TARGET_VERSION = 1;

export async function openLocalDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  const db = await SQLite.openDatabaseAsync("enforcer.db");
  // Sane defaults — WAL mode = better concurrent reads while a write is
  // in flight (matters when sessionManager appends a log while the
  // settings UI is reading). foreign_keys=ON because we'll have FK
  // relationships in the next phases (attack-profile → pcap-endpoint).
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
  `);
  await runMigrations(db);
  _db = db;
  return db;
}

async function runMigrations(db: SQLite.SQLiteDatabase) {
  const result = await db.getFirstAsync<{ user_version: number }>(
    "PRAGMA user_version",
  );
  let current = result?.user_version ?? 0;
  while (current < TARGET_VERSION) {
    const next = current + 1;
    // eslint-disable-next-line no-console
    console.log(`[localDb] migrating ${current} → ${next}`);
    switch (next) {
      case 1:
        // KV table for things that read+write as a single blob (settings,
        // future "app preferences" stuff). Cheap, flexible, easy to
        // extend without schema churn.
        await db.execAsync(`
          CREATE TABLE IF NOT EXISTS kv (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `);
        break;
      // Future migrations land here:
      // case 2: profiles + attack_profiles + ai_profiles + pcap_endpoints tables
      // case 3: command_logs table
      default:
        throw new Error(`[localDb] no migration for version ${next}`);
    }
    await db.execAsync(`PRAGMA user_version = ${next}`);
    current = next;
  }
}

// ─── KV helpers (generic JSON storage) ──────────────────────────────────
async function kvGet<T = any>(key: string): Promise<T | null> {
  const db = await openLocalDb();
  const row = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM kv WHERE key = ?",
    [key],
  );
  if (!row) return null;
  try { return JSON.parse(row.value) as T; }
  catch { return null; }
}

async function kvSet(key: string, value: any): Promise<void> {
  const db = await openLocalDb();
  const json = JSON.stringify(value);
  const now = new Date().toISOString();
  await db.runAsync(
    "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)",
    [key, json, now],
  );
}

// ─── Settings API ───────────────────────────────────────────────────────
// Mirrors the shape the backend Pydantic Settings model used to expose,
// so the rest of the app can swap fetch() → localDb.settings.get() with
// near-zero call-site changes.
export type Settings = {
  exec_mode: "mock" | "real" | "kali";
  iface_a: string;
  iface_b: string;
  iface_c: string;
  country: string;
  active_iface: string;
  chroot_path: string;
};

// Defaults match the backend's previous defaults exactly so first-launch
// experience is identical to a fresh backend seed.
const DEFAULT_SETTINGS: Settings = {
  exec_mode: "kali",
  iface_a: "wlan2",
  iface_b: "",
  iface_c: "",
  country: "US",
  active_iface: "A",
  // The "data_mirror/data_ce/null/0/..." chroot — only path that actually
  // works on OffSec NetHunter due to Android data isolation.
  chroot_path: "/data_mirror/data_ce/null/0/com.offsec.nethunter/scripts/bin/busybox_nh chroot /data/local/nhsystem/kalifs /usr/bin/sudo -E PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
};

export const settingsLocal = {
  /** Read settings, applying defaults for any missing fields. Never throws. */
  async get(): Promise<Settings> {
    const stored = await kvGet<Partial<Settings>>("settings");
    return { ...DEFAULT_SETTINGS, ...(stored || {}) };
  },

  /** Write settings. Merges with current values — caller only needs to pass changed fields. */
  async update(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.get();
    const next: Settings = { ...current, ...patch };
    await kvSet("settings", next);
    return next;
  },

  /** Force-overwrite the entire settings record. Use sparingly (debug, reset). */
  async replace(s: Settings): Promise<void> {
    await kvSet("settings", s);
  },

  /** Nuke. For "reset to defaults" UX. */
  async clear(): Promise<void> {
    const db = await openLocalDb();
    await db.runAsync("DELETE FROM kv WHERE key = ?", ["settings"]);
  },
};

// ─── Generic exports for future phases ──────────────────────────────────
// Other modules can use kvGet/kvSet directly for now; once we add proper
// tables for profiles etc. those'll get their own typed wrappers like
// settingsLocal above.
export { kvGet, kvSet };
