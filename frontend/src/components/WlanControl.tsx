/**
 * WlanControl — cockpit-style toggle deck for the quick tab.
 *
 * Replaces the old 12-tile "quick actions" grid. Symmetric UP/DOWN pairs
 * became 3 stateful toggles with glow-dot indicators, and the freed real
 * estate is now:
 *   • live `iw dev {iface} info` card (mode, channel, txpower, MAC) that
 *     auto-refreshes every 3s while the tab is focused,
 *   • a monitor-mode toggle that safely chains iface-down → set monitor →
 *     iface-up, and
 *   • a channel dial for the primary iface (chip-row with common 2.4G/5G
 *     channels — sidesteps a slider on mobile which is fiddly).
 *
 * State detection notes:
 *   • wifiOn:      `settings get global wifi_on`      → "1" / "0"
 *   • ifaceUp:     `ip link show {iface}`             → look for "state UP"
 *   • regDomain:   `iw reg get`                        → grep "country XX:"
 *                  toggle ON if it matches user's saved country, OFF if 00
 *   • monitorMode: `iw dev {iface} info`               → look for "type monitor"
 *
 * Every state read is best-effort — if parsing fails we surface it as
 * "unknown" (yellow dot) rather than lying.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { execReal, HAS_NATIVE_ROOT } from "../lib/rootShell";

const C = {
  bg: "#04070a", panel: "#0a1116", panel2: "#0e1820", border: "#163041",
  green: "#00ff66", greenDim: "#0a8a3a", cyan: "#3ad7ff",
  red: "#ff3860", yellow: "#ffd400", magenta: "#ff5cdb",
  text: "#cfeadb", textDim: "#6c8a82",
};
const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

type ToggleState = "on" | "off" | "unknown" | "probing";

/**
 * `iw dev` dumps a physical→interface tree. We just want the leaf
 * interface names (wlan0, wlan1, mon0…). Format we expect:
 *   phy#0
 *       Interface wlan0
 *           ifindex 42
 *           …
 *       Interface wlan1
 *           ifindex 43
 */
async function listWlanInterfaces(): Promise<string[]> {
  if (!HAS_NATIVE_ROOT) return [];
  try {
    const res = await execReal(`iw dev 2>/dev/null || true`);
    const out = res.output || "";
    const names = new Set<string>();
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^Interface\s+(\S+)/);
      if (m) names.add(m[1]);
    }
    return Array.from(names).sort();
  } catch { return []; }
}

/** Bulk single-round-trip state probe — one root shell call, many parses. */
async function probeAllStates(iface: string, country: string): Promise<{
  wifiOn: ToggleState;
  ifaceUp: ToggleState;
  regDomain: ToggleState;
  monitor: ToggleState;
  info: { mode?: string; channel?: string; txpower?: string; mac?: string };
  raw: string;
}> {
  const cmd = [
    `echo "=== wifi_on ==="`,
    `settings get global wifi_on 2>/dev/null || echo unknown`,
    `echo "=== link ==="`,
    `ip link show '${iface}' 2>/dev/null || echo NO_IFACE`,
    `echo "=== reg ==="`,
    `iw reg get 2>/dev/null | head -20 || echo NO_IW`,
    `echo "=== iwinfo ==="`,
    `iw dev '${iface}' info 2>/dev/null || echo NO_IWDEV`,
  ].join(" ; ");
  const res = await execReal(cmd);
  const out = res.output || "";

  // wifi_on: `1` or `0` (Android setting)
  const wifiOnMatch = out.match(/=== wifi_on ===\s*\r?\n\s*(\d)/);
  const wifiOn: ToggleState =
    wifiOnMatch?.[1] === "1" ? "on" :
    wifiOnMatch?.[1] === "0" ? "off" : "unknown";

  // link state: look for "state UP" in the ip link block
  const linkBlock = (out.match(/=== link ===[\s\S]*?(?====|$)/) || [""])[0];
  const ifaceUp: ToggleState =
    /state UP\b/.test(linkBlock) ? "on" :
    /state DOWN\b/.test(linkBlock) ? "off" :
    /NO_IFACE/.test(linkBlock) ? "unknown" : "unknown";

  // reg domain: match "country XX:" or "global"
  const regBlock = (out.match(/=== reg ===[\s\S]*?(?====|$)/) || [""])[0];
  const regMatch = regBlock.match(/country\s+([A-Z0-9]{2}):/);
  const currentCountry = regMatch?.[1] || "";
  const regDomain: ToggleState =
    !currentCountry ? "unknown" :
    currentCountry === country ? "on" :
    currentCountry === "00" ? "off" : "off";

  // iw dev info: extract mode/channel/txpower/mac
  const infoBlock = (out.match(/=== iwinfo ===[\s\S]*$/) || [""])[0];
  const modeMatch = infoBlock.match(/type\s+(\S+)/);
  const channelMatch = infoBlock.match(/channel\s+(\d+)/);
  const txpowerMatch = infoBlock.match(/txpower\s+([\d.]+\s*dBm)/);
  const macMatch = infoBlock.match(/addr\s+([0-9a-f:]{17})/i);
  const mode = modeMatch?.[1];
  const monitor: ToggleState =
    mode === "monitor" ? "on" :
    mode ? "off" : "unknown";

  return {
    wifiOn, ifaceUp, regDomain, monitor,
    info: {
      mode,
      channel: channelMatch?.[1],
      txpower: txpowerMatch?.[1],
      mac: macMatch?.[1],
    },
    raw: out,
  };
}

// Common channel presets — dodge the slider UX pain on mobile.
const CHANNELS_24 = [1, 6, 11];
const CHANNELS_5 = [36, 40, 44, 48, 149, 153, 157, 161];

type Props = {
  iface: string;
  country: string;
  onIfaceChange: (i: string) => void;
  /** Called with the raw command about to run so index.tsx can also log it
   *  in its command_logs table + jump to terminal for output visibility. */
  onExecCommand: (cmd: string, label: string) => Promise<void>;
  disabled?: boolean;
};

export default function WlanControl({
  iface, country, onIfaceChange, onExecCommand, disabled,
}: Props) {
  const [detected, setDetected] = useState<string[]>([]);
  const [state, setState] = useState<Awaited<ReturnType<typeof probeAllStates>> | null>(null);
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const refresh = useCallback(async () => {
    if (!HAS_NATIVE_ROOT) return;
    setProbing(true);
    try {
      const [ifaces, snap] = await Promise.all([
        listWlanInterfaces(),
        probeAllStates(iface, country),
      ]);
      if (!mountedRef.current) return;
      setDetected(ifaces);
      setState(snap);
    } catch (e) {
      console.warn("[WlanControl] probe failed:", e);
    } finally {
      if (mountedRef.current) setProbing(false);
    }
  }, [iface, country]);

  // Initial probe + periodic refresh while mounted. 4s cadence is a
  // compromise: fast enough that toggle latency feels alive, slow enough
  // that a chain of root shells doesn't hammer the device.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  const runAndRefresh = useCallback(async (cmd: string, label: string) => {
    setBusy(label);
    try {
      await onExecCommand(cmd, label);
      // Small delay so the state change lands before we re-probe.
      await new Promise((r) => setTimeout(r, 500));
      await refresh();
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [onExecCommand, refresh]);

  // ─── Toggle handlers ───────────────────────────────────────────────
  const handleWifiToggle = useCallback(() => {
    const target = state?.wifiOn === "on" ? "disable" : "enable";
    runAndRefresh(`svc wifi ${target}`, `wifi ${target}`);
  }, [state?.wifiOn, runAndRefresh]);

  const handleIfaceToggle = useCallback(() => {
    const target = state?.ifaceUp === "on" ? "down" : "up";
    runAndRefresh(`ifconfig ${iface} ${target}`, `iface ${target}`);
  }, [state?.ifaceUp, iface, runAndRefresh]);

  const handleRegToggle = useCallback(() => {
    const target = state?.regDomain === "on" ? "00" : country;
    runAndRefresh(`iw reg set ${target}`, `reg ${target}`);
  }, [state?.regDomain, country, runAndRefresh]);

  const handleMonitorToggle = useCallback(() => {
    // Monitor mode needs iface down first. We chain the whole thing in
    // one shell so partial states don't leave the iface in a weird spot.
    const target = state?.monitor === "on" ? "managed" : "monitor";
    const cmd =
      `ifconfig ${iface} down && ` +
      `iw dev ${iface} set type ${target} && ` +
      `ifconfig ${iface} up`;
    runAndRefresh(cmd, `monitor ${target}`);
  }, [state?.monitor, iface, runAndRefresh]);

  const handleSetChannel = useCallback((ch: number) => {
    runAndRefresh(`iw dev ${iface} set channel ${ch}`, `ch ${ch}`);
  }, [iface, runAndRefresh]);

  const ifaceList = useMemo(() => {
    // Merge detected list with the currently-selected iface so it's
    // always shown even if `iw dev` momentarily misses it.
    const s = new Set(detected);
    if (iface) s.add(iface);
    return Array.from(s).sort();
  }, [detected, iface]);

  return (
    <View style={s.root}>
      {/* Interface selector */}
      <Text style={s.sectionTitle}>{"// interface"}</Text>
      <View style={s.chipRow}>
        {ifaceList.length === 0 ? (
          <Text style={s.helperFine}>
            no wlan interfaces detected via <Text style={{ color: C.cyan }}>iw dev</Text>
          </Text>
        ) : ifaceList.map((n) => {
          const active = n === iface;
          return (
            <TouchableOpacity
              key={n}
              onPress={() => onIfaceChange(n)}
              style={[s.chip, active && { backgroundColor: C.green, borderColor: C.green }]}
              disabled={disabled}
            >
              <Text style={[s.chipText, active && { color: C.bg, fontWeight: "800" }]}>{n}</Text>
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity onPress={refresh} style={[s.chip, { borderColor: C.cyan }]} disabled={probing}>
          <MaterialCommunityIcons name="refresh" size={13} color={C.cyan} />
          <Text style={[s.chipText, { color: C.cyan, marginLeft: 4 }]}>
            {probing ? "…" : "sync"}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Toggles */}
      <Text style={[s.sectionTitle, { marginTop: 16 }]}>{"// controls"}</Text>

      <ToggleRow
        label="WiFi service"
        sub="svc wifi enable / disable"
        state={state?.wifiOn ?? "unknown"}
        busy={busy === "wifi enable" || busy === "wifi disable"}
        onPress={handleWifiToggle}
        disabled={disabled}
      />
      <ToggleRow
        label={`iface ${iface}`}
        sub={`ifconfig ${iface} up / down`}
        state={state?.ifaceUp ?? "unknown"}
        busy={busy === "iface up" || busy === "iface down"}
        onPress={handleIfaceToggle}
        disabled={disabled}
      />
      <ToggleRow
        label={`reg domain (${country || "??"})`}
        sub={`iw reg set ${country || "??"} / 00`}
        state={state?.regDomain ?? "unknown"}
        busy={busy?.startsWith("reg ") || false}
        onPress={handleRegToggle}
        disabled={disabled || !country}
      />
      <ToggleRow
        label="monitor mode"
        sub={`ifconfig down → iw set type monitor → up`}
        state={state?.monitor ?? "unknown"}
        busy={busy?.startsWith("monitor ") || false}
        onPress={handleMonitorToggle}
        disabled={disabled}
      />

      {/* Live iface stats */}
      <Text style={[s.sectionTitle, { marginTop: 16 }]}>{"// live"}</Text>
      <View style={s.card}>
        {state?.info ? (
          <>
            <StatRow k="mode"    v={state.info.mode || "—"}    color={state.info.mode === "monitor" ? C.magenta : C.cyan} />
            <StatRow k="channel" v={state.info.channel || "—"} color={C.cyan} />
            <StatRow k="txpower" v={state.info.txpower || "—"} color={C.cyan} />
            <StatRow k="mac"     v={state.info.mac || "—"}     color={C.cyan} />
          </>
        ) : (
          <Text style={s.helperFine}>… probing</Text>
        )}
      </View>

      {/* Channel dial */}
      <Text style={[s.sectionTitle, { marginTop: 16 }]}>{"// channel"}</Text>
      <Text style={s.helperFine}>
        2.4 GHz
      </Text>
      <View style={s.chipRow}>
        {CHANNELS_24.map((ch) => (
          <ChannelChip key={ch} ch={ch}
            active={state?.info.channel === String(ch)}
            busy={busy === `ch ${ch}`}
            onPress={() => handleSetChannel(ch)}
            disabled={disabled}
          />
        ))}
      </View>
      <Text style={[s.helperFine, { marginTop: 6 }]}>
        5 GHz
      </Text>
      <View style={s.chipRow}>
        {CHANNELS_5.map((ch) => (
          <ChannelChip key={ch} ch={ch}
            active={state?.info.channel === String(ch)}
            busy={busy === `ch ${ch}`}
            onPress={() => handleSetChannel(ch)}
            disabled={disabled}
          />
        ))}
      </View>
      <Text style={[s.helperFine, { marginTop: 8, color: C.textDim }]}>
        tip: setting a channel requires monitor mode or an unassociated managed iface.
        driver may reject if the channel is outside the current reg domain.
      </Text>
    </View>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────
function ToggleRow({
  label, sub, state, busy, onPress, disabled,
}: {
  label: string; sub: string; state: ToggleState; busy: boolean;
  onPress: () => void; disabled?: boolean;
}) {
  // Dot color mirrors the mcp node status pill: green = on, dim = off,
  // yellow = probing/unknown/busy. The subtle inner glow is done with a
  // slightly larger, translucent halo circle underneath.
  const dotColor =
    state === "on" ? C.green :
    state === "off" ? C.textDim :
    C.yellow;
  const glowShown = state === "on" || busy;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || busy}
      activeOpacity={0.7}
      style={[s.toggleRow, disabled && { opacity: 0.5 }]}
    >
      <View style={s.dotWrap}>
        {glowShown && <View style={[s.dotGlow, { backgroundColor: dotColor }]} />}
        <View style={[s.dot, { backgroundColor: dotColor }]} />
      </View>
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={s.toggleLabel}>{label}</Text>
        <Text style={s.toggleSub}>{sub}</Text>
      </View>
      <View style={[s.toggleTrack, state === "on" && { backgroundColor: C.greenDim }]}>
        <View style={[s.toggleKnob, {
          left: state === "on" ? 20 : 2,
          backgroundColor: busy ? C.yellow : state === "on" ? C.green : C.text,
        }]} />
      </View>
    </TouchableOpacity>
  );
}

function StatRow({ k, v, color }: { k: string; v: string; color: string }) {
  return (
    <View style={{ flexDirection: "row", marginBottom: 2 }}>
      <Text style={[s.helperFine, { width: 80 }]}>{k}</Text>
      <Text style={[s.helperFine, { color, flex: 1 }]}>{v}</Text>
    </View>
  );
}

function ChannelChip({ ch, active, busy, onPress, disabled }: {
  ch: number; active?: boolean; busy?: boolean; onPress: () => void; disabled?: boolean;
}) {
  const color = busy ? C.yellow : active ? C.bg : C.green;
  const bg = active ? C.green : "transparent";
  const border = active ? C.green : busy ? C.yellow : C.border;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || busy}
      style={[s.chip, { backgroundColor: bg, borderColor: border, minWidth: 44 }]}
    >
      <Text style={[s.chipText, { color, fontWeight: active ? "800" : "600" }]}>{ch}</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  root: { paddingVertical: 4 },
  sectionTitle: { color: C.green, fontFamily: MONO, fontSize: 12, fontWeight: "700", letterSpacing: 1 },
  helperFine: { color: C.text, fontFamily: MONO, fontSize: 11 },
  chipRow: { flexDirection: "row", marginTop: 6, flexWrap: "wrap", gap: 6 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderWidth: 1, borderColor: C.border, borderRadius: 3,
    backgroundColor: C.panel, alignItems: "center", justifyContent: "center",
    flexDirection: "row",
  },
  chipText: { color: C.green, fontFamily: MONO, fontSize: 12, fontWeight: "600" },
  card: {
    padding: 12, borderWidth: 1, borderColor: C.border, borderRadius: 4,
    backgroundColor: C.panel, marginTop: 6,
  },
  toggleRow: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 12, paddingVertical: 10,
    borderWidth: 1, borderColor: C.border, borderRadius: 4,
    backgroundColor: C.panel, marginTop: 8,
  },
  toggleLabel: { color: C.text, fontFamily: MONO, fontSize: 13, fontWeight: "700" },
  toggleSub: { color: C.textDim, fontFamily: MONO, fontSize: 10, marginTop: 2 },
  toggleTrack: {
    width: 42, height: 22, borderRadius: 11, backgroundColor: C.border,
    justifyContent: "center",
  },
  toggleKnob: {
    width: 18, height: 18, borderRadius: 9,
    position: "absolute", top: 2,
  },
  dotWrap: {
    width: 14, height: 14, alignItems: "center", justifyContent: "center",
    position: "relative",
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotGlow: {
    width: 18, height: 18, borderRadius: 9, opacity: 0.35,
    position: "absolute",
  },
});
