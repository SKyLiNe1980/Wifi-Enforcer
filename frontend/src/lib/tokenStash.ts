/**
 * tokenStash.ts — Upstash Redis REST client + node-bearer rotation logic.
 *
 * Purpose: solve two related problems with one system.
 *   1. Reinstall recovery — cockpit's local `mcp_nodes` gets wiped on
 *      APK uninstall. We store the current cluster bearer in Upstash so
 *      a freshly-reinstalled cockpit can restore its node roster (via
 *      tailnet peer discovery + token fetch) with zero manual pasting.
 *   2. Static-bearer risk — nodes have all shared one long-lived token
 *      forever. Rotation on a schedule (~15 min) limits the blast radius
 *      of any leak. Nodes will poll the same stash and refresh their
 *      config.yaml — implemented in enforcer-mcp 0.3.0 (next .deb bump).
 *
 * ONLY the cockpit writes. Nodes only read. Read/write is enforced by
 * which token each side holds — this file always uses the R/W token.
 *
 * Sensitive material handling:
 *   • The Upstash REST TOKEN lives in expo-secure-store (Keystore-backed
 *     on Android). Never in SQLite, never in .env, never logged.
 *   • The Upstash REST URL lives in mcp_config (SQLite) — it's not
 *     secret, just an endpoint address.
 *   • The bearer tokens WE store IN Upstash are the node cluster bearers;
 *     they're sensitive at rest but Upstash provides TLS in transit.
 */
import * as SecureStore from "expo-secure-store";

// Secure Store key names. Prefixed for hygiene and easy `expo-secure-store`
// enumeration if we ever need a "wipe all cockpit secrets" op.
const SS_UPSTASH_TOKEN = "enforcer.upstash.rest_token";
const SS_UPSTASH_URL = "enforcer.upstash.rest_url";

// Redis key names inside Upstash. Namespaced under enforcer:* so multiple
// deployments/environments could share one DB if you ever wanted.
export const KEY_CURRENT = "enforcer:bearer:current";
export const KEY_PREVIOUS = "enforcer:bearer:previous";
// Small heartbeat key the cockpit writes on each successful rotation —
// lets you see "when did the last rotation happen" from redis-cli.
export const KEY_LAST_ROTATED = "enforcer:bearer:last_rotated_at";
// A cluster-wide "who's the current owner cockpit" marker — first cockpit
// to write wins for the rotation loop; a second cockpit sees this and
// stays read-only. Prevents two cockpits fighting over rotations.
export const KEY_ROTATION_OWNER = "enforcer:bearer:rotation_owner";

// Suggested TTLs so orphaned rows self-evict from Upstash if the cockpit
// stops rotating (e.g. app uninstalled while a rotation was in flight).
export const TTL_CURRENT_SEC = 30 * 60;   // 30min — 2× rotation cadence
export const TTL_PREVIOUS_SEC = 20 * 60;  // 20min — covers grace period well
export const TTL_HEARTBEAT_SEC = 60 * 60; // 60min

export type BearerRecord = {
  token: string;
  rotated_at: string; // ISO
};

/**
 * Load the persisted REST token from secure storage. Returns null if the
 * user hasn't paired the cockpit with an Upstash DB yet.
 */
export async function loadUpstashToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(SS_UPSTASH_TOKEN);
  } catch (e) {
    console.warn("[tokenStash] SecureStore read failed:", e);
    return null;
  }
}

export async function saveUpstashToken(token: string): Promise<void> {
  if (!token) throw new Error("token is empty");
  await SecureStore.setItemAsync(SS_UPSTASH_TOKEN, token, {
    // Force platform default (Keystore on Android, Keychain on iOS).
    // No biometric prompt on read — we need programmatic access from
    // rotation timer. Users who want stricter can layer app-level auth.
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  });
}

export async function clearUpstashToken(): Promise<void> {
  try { await SecureStore.deleteItemAsync(SS_UPSTASH_TOKEN); } catch { /* no-op */ }
  try { await SecureStore.deleteItemAsync(SS_UPSTASH_URL); } catch { /* no-op */ }
}

export async function loadUpstashUrl(): Promise<string | null> {
  try { return await SecureStore.getItemAsync(SS_UPSTASH_URL); } catch { return null; }
}
export async function saveUpstashUrl(url: string): Promise<void> {
  await SecureStore.setItemAsync(SS_UPSTASH_URL, url.replace(/\/+$/, ""), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  });
}

/**
 * Low-level Upstash REST call. Upstash's REST API accepts Redis commands
 * as URL path segments, e.g.:
 *   POST /SET/foo/bar     body ignored on this style
 *   POST /GET/foo         (body ignored)
 *   POST /                body = ["SET","foo","bar","EX","300"] (array-form, best)
 * We use the array-form because it handles arbitrary values (spaces, JSON,
 * base64) cleanly without URL-encoding surprises.
 *
 * Errors are turned into Error objects with useful messages so callers can
 * surface them in the UI without parsing JSON themselves.
 */
async function upstashCmd(
  restUrl: string,
  restToken: string,
  argv: (string | number)[],
): Promise<any> {
  if (!restUrl) throw new Error("Upstash URL not configured");
  if (!restToken) throw new Error("Upstash R/W token not configured");
  // Strip trailing slash if user pasted one — annoying gotcha otherwise.
  const url = restUrl.replace(/\/+$/, "");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${restToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(argv.map(String)),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    // Upstash errors come back as { "error": "..." } most of the time.
    let msg = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed?.error) msg = `${msg}: ${parsed.error}`;
    } catch { msg = `${msg}: ${bodyText.slice(0, 200)}`; }
    throw new Error(`Upstash: ${msg}`);
  }
  try {
    const parsed = JSON.parse(bodyText);
    // Success envelope: { "result": ... }
    return parsed?.result;
  } catch {
    return bodyText;
  }
}

/**
 * Cheap connectivity + auth probe — used by the TEST CONNECTION button in
 * the settings UI. Uses PING which is authorized for R/O tokens too, so
 * even a mis-pasted read-only token still returns success ("PONG"). If
 * the user needs to confirm R/W, they can then hit the ROTATE NOW button.
 */
export async function testConnection(restUrl: string, restToken: string): Promise<string> {
  const r = await upstashCmd(restUrl, restToken, ["PING"]);
  return typeof r === "string" ? r : JSON.stringify(r);
}

/**
 * Fetch the current cluster bearer from Upstash. Returns null if the key
 * doesn't exist yet (fresh Upstash DB, cockpit never rotated).
 */
export async function fetchCurrentBearer(
  restUrl: string, restToken: string,
): Promise<BearerRecord | null> {
  const raw = await upstashCmd(restUrl, restToken, ["GET", KEY_CURRENT]);
  if (!raw) return null;
  try { return JSON.parse(raw as string) as BearerRecord; }
  catch { return null; }
}

/**
 * Push a freshly-generated bearer to Upstash as the new current, moving
 * the previous one aside for grace-window consumption. Also updates the
 * `last_rotated_at` heartbeat key so operators can eyeball rotation
 * health from redis-cli.
 *
 * Returns the new record on success. Failures throw — caller decides
 * whether to retry / surface the error / disable rotation.
 */
export async function rotateBearer(
  restUrl: string, restToken: string, newToken: string,
): Promise<BearerRecord> {
  const now = new Date().toISOString();
  const newRec: BearerRecord = { token: newToken, rotated_at: now };
  // 1) Read current (about-to-become-previous). Best-effort — if this
  //    fails, we still push the new one; nodes just lose 1 rotation of
  //    grace-overlap which is acceptable.
  let oldRec: BearerRecord | null = null;
  try {
    oldRec = await fetchCurrentBearer(restUrl, restToken);
  } catch (e) {
    console.warn("[tokenStash] fetch old bearer failed (non-fatal):", e);
  }

  // 2) Write PREVIOUS first (so nodes that poll BETWEEN our next two
  //    writes still see a valid grace token during the tiny window).
  if (oldRec) {
    await upstashCmd(restUrl, restToken, [
      "SET", KEY_PREVIOUS, JSON.stringify(oldRec),
      "EX", TTL_PREVIOUS_SEC,
    ]);
  }
  // 3) Now write CURRENT.
  await upstashCmd(restUrl, restToken, [
    "SET", KEY_CURRENT, JSON.stringify(newRec),
    "EX", TTL_CURRENT_SEC,
  ]);
  // 4) Heartbeat.
  await upstashCmd(restUrl, restToken, [
    "SET", KEY_LAST_ROTATED, now,
    "EX", TTL_HEARTBEAT_SEC,
  ]);
  return newRec;
}

/**
 * Generate a fresh 64-char hex bearer client-side. Uses WebCrypto which
 * is available in modern Hermes (Expo SDK 54+). Falls back to Math.random
 * only if crypto is missing — noisy warning if that ever happens.
 */
export function generateBearer(): string {
  const g = (globalThis as any).crypto;
  if (g?.getRandomValues) {
    const arr = new Uint8Array(32);
    g.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  console.warn("[tokenStash] WebCrypto missing — falling back to Math.random. NOT for prod.");
  let out = "";
  for (let i = 0; i < 64; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

// ─── Tailnet peer discovery ─────────────────────────────────────────────

export type DiscoveredPeer = {
  hostname: string;      // MagicDNS short name, e.g. "pwn"
  dnsName: string;       // Full MagicDNS name, e.g. "pwn.tailXXXX.ts.net"
  tailIp: string;        // 100.x.y.z IPv4
  online: boolean;
};

/**
 * Enumerate tailnet peers that match the enforcer naming convention
 * (hostname contains "node" or "enforcer", case-insensitive). Uses
 * `tailscale status --json` via root shell — one call, deterministic.
 *
 * Rationale over trial-and-error probing: convention-based discovery is
 * predictable ("if you want it in the swarm, name it accordingly") and
 * only costs ONE root call regardless of tailnet size. Trial probing
 * would cost N root/curl calls and pop N Magisk prompts.
 *
 * `execReal` is imported by caller (deployServer.ts already imports it
 * from rootShell); we accept it as a param so this module stays pure
 * TypeScript with no root-shell coupling — makes it unit-testable.
 */
export async function discoverEnforcerPeers(
  execReal: (cmd: string) => Promise<{ output: string; exit_code: number }>,
  pattern: RegExp = /node|enforcer/i,
): Promise<DiscoveredPeer[]> {
  const res = await execReal(`tailscale status --json 2>/dev/null || echo '{}'`);
  if (res.exit_code !== 0) return [];
  let parsed: any;
  try { parsed = JSON.parse(res.output || "{}"); } catch { return []; }
  const peers = parsed?.Peer;
  if (!peers || typeof peers !== "object") return [];
  const out: DiscoveredPeer[] = [];
  for (const p of Object.values<any>(peers)) {
    const hostname = p?.HostName || "";
    const dnsName = p?.DNSName || "";
    if (!hostname && !dnsName) continue;
    // Match against short hostname AND FQDN — either can contain the
    // convention token depending on how the operator named things.
    if (!pattern.test(hostname) && !pattern.test(dnsName)) continue;
    const tailIp = (p?.TailscaleIPs || []).find((ip: string) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
    if (!tailIp) continue;
    out.push({
      hostname,
      dnsName: dnsName.replace(/\.$/, ""), // strip trailing dot from FQDN
      tailIp,
      online: !!p?.Online,
    });
  }
  return out.sort((a, b) => a.hostname.localeCompare(b.hostname));
}
