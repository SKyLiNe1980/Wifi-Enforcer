/**
 * swatBus — JS bridge to the native SWAT foreground-connection service.
 *
 * Keeps the app process (and thus the IRC WebSocket + ping/pong timers) alive
 * while backgrounded, via an Android foreground service + partial wakelock +
 * persistent notification. Degrades to no-ops off-Android / in Expo Go.
 */
import { NativeModules, Platform } from "react-native";

const N: any = NativeModules.SwatBus;
export const HAS_SWAT_BUS = Platform.OS === "android" && !!N;

/** Start the foreground service (call when a connection is wanted). */
export async function busStart(nick: string, channel: string): Promise<void> {
  if (!HAS_SWAT_BUS) return;
  try { await N.start(nick, channel); } catch { /* noop */ }
}

/** Stop it (manual disconnect). */
export async function busStop(): Promise<void> {
  if (!HAS_SWAT_BUS) return;
  try { await N.stop(); } catch { /* noop */ }
}

/** Reflect connection state in the persistent notification (LED colour + text). */
export async function busUpdate(status: string, nick: string, channel: string, info: string): Promise<void> {
  if (!HAS_SWAT_BUS) return;
  try { await N.update(status, nick || "", channel || "", info || ""); } catch { /* noop */ }
}

/** Fire a one-shot heads-up alert for a #SWAT event (@mention / MISSION /
 *  HALT). Local only — no FCM. No-op off-Android / in Expo Go. */
export async function busNotify(title: string, body: string, color: string): Promise<void> {
  if (!HAS_SWAT_BUS) return;
  try { await N.notify(title || "SWAT", body || "", color || "#00ff66"); } catch { /* noop */ }
}

/** One-time keep-alive opt-in: notification permission + battery-opt exemption. */
export async function busEnableKeepAlive(): Promise<void> {
  if (!HAS_SWAT_BUS) return;
  try { await N.requestNotifPermission(); } catch { /* noop */ }
  try { await N.requestBatteryExemption(); } catch { /* noop */ }
}

/** Open the battery-optimisation exemption dialog (REQUEST_IGNORE_BATTERY_OPT). */
export async function busRequestBattery(): Promise<void> {
  if (!HAS_SWAT_BUS) return;
  try { await N.requestBatteryExemption(); } catch { /* noop */ }
}

export async function busIsIgnoringBattery(): Promise<boolean> {
  if (!HAS_SWAT_BUS) return false;
  try { return await N.isIgnoringBattery(); } catch { return false; }
}

// ── Wakelock (Kali-term style, default OFF) ─────────────────────────────────
/** Acquire/release the partial wakelock. */
export async function busSetWake(on: boolean): Promise<void> {
  if (!HAS_SWAT_BUS) return;
  try { await N.setWake(on); } catch { /* noop */ }
}
/** Flip the wakelock. */
export async function busToggleWake(): Promise<void> {
  if (!HAS_SWAT_BUS) return;
  try { await N.toggleWake(); } catch { /* noop */ }
}
/** Is the wakelock currently held? */
export async function busIsWakeHeld(): Promise<boolean> {
  if (!HAS_SWAT_BUS) return false;
  try { return await N.isWakeHeld(); } catch { return false; }
}
