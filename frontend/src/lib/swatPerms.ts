/**
 * swatPerms — thin permission helpers for the SWAT keep-alive stack.
 *
 * Notifications use the REAL runtime dialog (PermissionsAndroid) instead of
 * just deep-linking to settings, so the operator gets the system prompt on
 * first launch. Battery-optimisation exemption is a Settings intent (there's
 * no runtime dialog for it) routed through the native SwatBus module.
 */
import { PermissionsAndroid, Platform, Linking } from "react-native";
import { busIsIgnoringBattery, busRequestBattery } from "./swatBus";

export type PermState = "granted" | "denied" | "blocked" | "unsupported";

const POST_NOTIF = "android.permission.POST_NOTIFICATIONS" as any;

/** Current notification permission state. Pre-Android-13 it's implicit. */
export async function checkNotifPerm(): Promise<PermState> {
  if (Platform.OS !== "android") return "unsupported";
  if (typeof Platform.Version === "number" && Platform.Version < 33) return "granted";
  try {
    const ok = await PermissionsAndroid.check(POST_NOTIF);
    return ok ? "granted" : "denied";
  } catch { return "denied"; }
}

/**
 * Fire the system notification permission dialog. Returns the resulting state.
 * "blocked" means the OS won't show the dialog again (user hit "don't ask") —
 * caller should route to app settings.
 */
export async function requestNotifPerm(): Promise<PermState> {
  if (Platform.OS !== "android") return "unsupported";
  if (typeof Platform.Version === "number" && Platform.Version < 33) return "granted";
  try {
    const res = await PermissionsAndroid.request(POST_NOTIF);
    if (res === PermissionsAndroid.RESULTS.GRANTED) return "granted";
    if (res === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return "blocked";
    return "denied";
  } catch { return "denied"; }
}

/** Deep-link to this app's settings screen (for blocked perms). */
export async function openAppSettings(): Promise<void> {
  try { await Linking.openSettings(); } catch { /* noop */ }
}

export { busIsIgnoringBattery as isBatteryExempt, busRequestBattery as requestBatteryExempt };
