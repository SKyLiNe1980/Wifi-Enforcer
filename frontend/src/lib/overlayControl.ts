/**
 * overlayControl — JS bridge to the native system-wide overlay (Android).
 *
 * The native OverlayControl module + OverlayService draw a floating command
 * bubble ON TOP OF OTHER APPS via WindowManager (needs "Display over other
 * apps" permission). This wrapper degrades gracefully to no-ops in Expo Go /
 * web / iOS where the native module isn't present, so callers never crash.
 *
 * Config flow: the RN toolbar config (slots) is resolved here into a compact
 * payload — each MCP-tool slot gets its target node's host/port/token inlined
 * so the service can fire the call itself without the app being focused — and
 * pushed to the service via syncConfig().
 */
import { NativeModules, Platform } from "react-native";
import { nodesLocal } from "./localDb";
import type { ToolbarConfig } from "./toolbarStore";

const N: any = NativeModules.OverlayControl;

/** True only in a native Android build that shipped the overlay module. */
export const HAS_OVERLAY = Platform.OS === "android" && !!N;

export async function overlayHasPermission(): Promise<boolean> {
  if (!HAS_OVERLAY) return false;
  try { return await N.hasPermission(); } catch { return false; }
}

export async function overlayRequestPermission(): Promise<void> {
  if (!HAS_OVERLAY) return;
  try { await N.requestPermission(); } catch { /* user cancelled / no activity */ }
}

export async function overlayShow(): Promise<void> {
  if (!HAS_OVERLAY) return;
  await N.show();
}

export async function overlayHide(): Promise<void> {
  if (!HAS_OVERLAY) return;
  try { await N.hide(); } catch { /* not running */ }
}

export async function overlayIsRunning(): Promise<boolean> {
  if (!HAS_OVERLAY) return false;
  try { return await N.isRunning(); } catch { return false; }
}

export async function overlayConsumePendingSlot(): Promise<string | null> {
  if (!HAS_OVERLAY) return null;
  try { return await N.consumePendingSlot(); } catch { return null; }
}

/** Resolve slots → native payload (inlining node creds for MCP slots) and push. */
export async function syncOverlayConfig(cfg: ToolbarConfig): Promise<void> {
  if (!HAS_OVERLAY) return;
  const slots: any[] = [];
  for (const s of cfg.slots) {
    const out: any = { id: s.id, label: s.label, led: s.led, kind: s.kind };
    if (s.kind === "mcp_tool") {
      out.tool = s.tool || "";
      out.args = s.args || {};
      if (s.nodeId) {
        try {
          const node = await nodesLocal.get(s.nodeId);
          if (node) {
            out.host = node.host;
            out.port = node.port;
            out.token = node.bearer_token || "";
          }
        } catch { /* node lookup failed — slot fires as "not configured" */ }
      }
    } else if (s.kind === "navigate") {
      out.route = s.route || "";
    } else {
      out.appAction = s.appAction || "";
    }
    slots.push(out);
  }
  const payload = JSON.stringify({ enabled: cfg.enabled, systemOverlay: !!cfg.systemOverlay, slots });
  try { await N.syncConfig(payload); } catch { /* prefs write failed — non-fatal */ }
}
