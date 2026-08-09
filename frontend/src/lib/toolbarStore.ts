/**
 * toolbarStore — persistence for the global floating command toolbar.
 *
 * Config (slots + position + collapsed/enabled) lives in the localDb kv store
 * as a single JSON blob, so there's no schema migration to manage. A tiny
 * pub/sub lets the overlay + config sheet stay in sync without a global store
 * library.
 */
import { kvGet, kvSet } from "./localDb";

const KEY = "toolbar_config_v1";

export type SlotKind = "mcp_tool" | "app" | "navigate";
export type AppAction = "snapshot" | "restore" | "revive";

export type ToolbarSlot = {
  id: string;
  label: string;      // short engraved label (<= ~6 chars looks best)
  icon: string;       // MaterialCommunityIcons name
  led: string;        // idle LED color (hex)
  kind: SlotKind;
  // kind === "mcp_tool" | "revive": which node to target
  nodeId?: string;
  // kind === "mcp_tool"
  tool?: string;
  args?: Record<string, string>;
  // kind === "app"
  appAction?: AppAction;
  // kind === "navigate"
  route?: string;
};

export type ToolbarConfig = {
  enabled: boolean;
  collapsed: boolean;
  x: number;
  y: number;
  slots: ToolbarSlot[];
};

const LED = { green: "#00ff66", amber: "#ffd400", cyan: "#3ad7ff", red: "#ff3860" };

export function defaultConfig(): ToolbarConfig {
  return {
    enabled: true,
    collapsed: true,
    x: -1, // -1 => compute from screen on first mount (dock right)
    y: -1,
    slots: [
      { id: "s1", label: "PMKID", icon: "wifi", led: LED.amber, kind: "mcp_tool",
        tool: "exec_command", args: { cmd: "wifite --pmkid --kill" } },
      { id: "s2", label: "SNAP", icon: "cloud-upload", led: LED.cyan, kind: "app", appAction: "snapshot" },
      { id: "s3", label: "REVIVE", icon: "restart", led: LED.green, kind: "app", appAction: "revive" },
      { id: "s4", label: "LIVE", icon: "pulse", led: LED.green, kind: "navigate", route: "/(tabs)/live" },
    ],
  };
}

let cache: ToolbarConfig | null = null;
type Listener = (c: ToolbarConfig) => void;
const listeners = new Set<Listener>();

export async function loadToolbarConfig(): Promise<ToolbarConfig> {
  if (cache) return cache;
  const stored = await kvGet<ToolbarConfig>(KEY);
  cache = stored && Array.isArray(stored.slots) ? { ...defaultConfig(), ...stored } : defaultConfig();
  return cache;
}

export async function saveToolbarConfig(next: ToolbarConfig): Promise<void> {
  cache = next;
  await kvSet(KEY, next);
  listeners.forEach((l) => l(next));
}

/** Persist just the position (called on drag end — avoids clobbering slots). */
export async function saveToolbarPosition(x: number, y: number, collapsed: boolean): Promise<void> {
  const cur = await loadToolbarConfig();
  await saveToolbarConfig({ ...cur, x, y, collapsed });
}

export function subscribeToolbar(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const LED_COLORS = LED;
