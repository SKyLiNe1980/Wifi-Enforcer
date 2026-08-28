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

/** One-time keep-alive opt-in: notification permission + battery-opt exemption. */
export async function busEnableKeepAlive(): Promise<void> {
  if (!HAS_SWAT_BUS) return;
  try { await N.requestNotifPermission(); } catch { /* noop */ }
  try { await N.requestBatteryExemption(); } catch { /* noop */ }
}

export async function busIsIgnoringBattery(): Promise<boolean> {
  if (!HAS_SWAT_BUS) return false;
  try { return await N.isIgnoringBattery(); } catch { return false; }
}
