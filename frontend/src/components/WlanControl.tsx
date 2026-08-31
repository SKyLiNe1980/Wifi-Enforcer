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
import { Modal, Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
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
 * Bulk single-round-trip state probe — ONE root shell call, many parses.
 * Now includes interface enumeration too, so a full state refresh costs
 * exactly one `execReal` (and therefore at most one Magisk prompt if the
 * user has it set to prompt-every-time).
 */
async function probeAllStates(iface: string, country: string): Promise<{
  wifiOn: ToggleState;
  ifaceUp: ToggleState;
  regDomain: ToggleState;
  monitor: ToggleState;
  info: { mode?: string; channel?: string; txpower?: string; mac?: string };
  interfaces: string[];
  raw: string;
}> {
  const cmd = [
    `echo "=== ifaces ==="`,
    `iw dev 2>/dev/null || true`,
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

  // Interface list from `iw dev` block
  const ifaceBlock = (out.match(/=== ifaces ===[\s\S]*?(?====|$)/) || [""])[0];
  const interfacesSet = new Set<string>();
  for (const line of ifaceBlock.split(/\r?\n/)) {
    const m = line.trim().match(/^Interface\s+(\S+)/);
    if (m) interfacesSet.add(m[1]);
  }
  const interfaces = Array.from(interfacesSet).sort();

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
    interfaces,
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
  /** Save the current toggle combo as a reusable profile. Receives the
   *  toggle-derived command sequence; the parent opens its save sheet. */
  onSaveCombo?: (commands: string[]) => void;
  disabled?: boolean;
};

export default function WlanControl({
  iface, country, onIfaceChange, onExecCommand, onSaveCombo, disabled,
}: Props) {
  const [detected, setDetected] = useState<string[]>([]);
  const [state, setState] = useState<Awaited<ReturnType<typeof probeAllStates>> | null>(null);
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [chanSheetOpen, setChanSheetOpen] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const refresh = useCallback(async () => {
    if (!HAS_NATIVE_ROOT) return;
    setProbing(true);
    try {
      const snap = await probeAllStates(iface, country);
      if (!mountedRef.current) return;
      // Interface list now comes from the same batched probe — no
      // separate root call needed. Falls back to previous list if the
      // probe returns empty (transient failure).
      if (snap.interfaces.length > 0) setDetected(snap.interfaces);
      setState(snap);
    } catch (e) {
      console.warn("[WlanControl] probe failed:", e);
    } finally {
      if (mountedRef.current) setProbing(false);
    }
  }, [iface, country]);

  // Initial probe on mount, and re-probe whenever the target iface or
  // country changes (both are legit user-initiated triggers). NO polling
  // loop — a repeated root call every N seconds caused a firehose of
  // Magisk prompts on some devices and flickered the sync chip. State
  // is now only ever refreshed on: initial mount · iface/country change
  // · after a toggle fires · manual "sync" tap.
  useEffect(() => {
    refresh();
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

  // ─── One-tap preset combos ──────────────────────────────────────────
  // Built-in staged sequences that fire the whole chain at once. Applying
  // a preset runs through the same exec pipeline as individual toggles and
  // re-probes state afterwards so the toggles light up to match.
  const PRESETS = useMemo(() => [
    { key: "sniff", label: "sniff", icon: "access-point" as const, color: C.cyan,
      cmd: `svc wifi disable && ifconfig ${iface} down && iw dev ${iface} set type monitor && ifconfig ${iface} up` },
    { key: "inject", label: "inject", icon: "radio-tower" as const, color: C.magenta,
      cmd: `svc wifi disable && iw reg set ${country || "00"} && ifconfig ${iface} down && iw dev ${iface} set type monitor && ifconfig ${iface} up` },
    { key: "reset", label: "reset", icon: "backup-restore" as const, color: C.yellow,
      cmd: `ifconfig ${iface} down && iw dev ${iface} set type managed && ifconfig ${iface} up && svc wifi enable` },
  ], [iface, country]);

  // Snapshot the CURRENT toggle states into a reproducible command sequence
  // (ordered so monitor-mode's down→set→up chain stays valid).
  const buildComboFromState = useCallback((): string[] => {
    if (!state) return [];
    const cmds: string[] = [];
    cmds.push(`svc wifi ${state.wifiOn === "on" ? "enable" : "disable"}`);
    if (country && state.regDomain === "on") cmds.push(`iw reg set ${country}`);
    cmds.push(`ifconfig ${iface} down`);
    cmds.push(`iw dev ${iface} set type ${state.monitor === "on" ? "monitor" : "managed"}`);
    if (state.ifaceUp === "on") cmds.push(`ifconfig ${iface} up`);
    return cmds;
  }, [state, iface, country]);

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

      {/* Host interop — Android WiFi service is step 0: kill it before Kali
          gets clean raw hardware access. Styled as a master switch (red when
          ON = still interfering). */}
      <Text style={[s.sectionTitle, { marginTop: 16 }]}>{"// host interop"}</Text>
      <ToggleRow
        label="Android WiFi svc"
        sub={state?.wifiOn === "on" ? "⚠ may fight Kali — kill first" : "off — hardware free for Kali"}
        state={state?.wifiOn ?? "unknown"}
        busy={busy === "wifi enable" || busy === "wifi disable"}
        onPress={handleWifiToggle}
        disabled={disabled}
        master
      />

      {/* Live telemetry HUD — hoisted above the controls so active state is
          glanceable without scrolling. */}
      <Text style={[s.sectionTitle, { marginTop: 16 }]}>{"// live"}</Text>
      <View style={s.hudCard}>
        {state?.info ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
            <HudCell k="mode" v={state.info.mode || "—"} color={state.info.mode === "monitor" ? C.magenta : C.cyan} />
            <HudCell k="ch" v={state.info.channel || "—"} color={C.cyan} />
            <HudCell k="tx" v={state.info.txpower || "—"} color={C.cyan} />
            <HudCell k="mac" v={state.info.mac || "—"} color={C.cyan} wide />
          </View>
        ) : (
          <Text style={s.helperFine}>… probing</Text>
        )}
      </View>

      {/* Preset combos — one-tap staged actions + save the current combo */}
      <View style={s.sectionRow}>
        <Text style={s.sectionTitle}>{"// presets"}</Text>
        {onSaveCombo && (
          <TouchableOpacity
            testID="btn-save-combo"
            onPress={() => onSaveCombo(buildComboFromState())}
            disabled={disabled || !state}
            style={[s.chip, { borderColor: C.green, paddingVertical: 4 }]}
          >
            <MaterialCommunityIcons name="content-save" size={12} color={C.green} />
            <Text style={[s.chipText, { color: C.green, marginLeft: 4, fontSize: 11 }]}>save combo</Text>
          </TouchableOpacity>
        )}
      </View>
      <View style={s.chipRow}>
        {PRESETS.map((p) => (
          <TouchableOpacity
            key={p.key}
            testID={`preset-${p.key}`}
            onPress={() => runAndRefresh(p.cmd, p.key)}
            disabled={disabled || !!busy}
            style={[s.chip, { borderColor: p.color }]}
          >
            <MaterialCommunityIcons name={p.icon} size={12} color={p.color} />
            <Text style={[s.chipText, { color: p.color, marginLeft: 4 }]}>{p.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Controls */}
      <Text style={[s.sectionTitle, { marginTop: 16 }]}>{"// controls"}</Text>

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

      {/* Channel — compact readout that opens a bottom-sheet picker. The old
          always-visible chip grid ate ~30% of the viewport; collapsed here
          until the Enforcer Toolbar jog-wheels take over channel/TX entirely. */}
      <Text style={[s.sectionTitle, { marginTop: 16 }]}>{"// channel"}</Text>
      <TouchableOpacity
        testID="btn-channel-readout"
        style={s.readoutRow}
        onPress={() => setChanSheetOpen(true)}
        disabled={disabled}
        activeOpacity={0.7}
      >
        <Text style={s.readoutText}>Ch: <Text style={{ color: C.green, fontWeight: "800" }}>{state?.info.channel || "—"}</Text></Text>
        <Text style={s.readoutText}>Tx: <Text style={{ color: C.cyan, fontWeight: "800" }}>{state?.info.txpower || "—"}</Text></Text>
        <MaterialCommunityIcons name="chevron-down" size={16} color={C.textDim} />
      </TouchableOpacity>

      {/* Channel picker bottom-sheet */}
      <Modal
        visible={chanSheetOpen}
        transparent
        animationType="none"
        onRequestClose={() => setChanSheetOpen(false)}
      >
        <TouchableOpacity
          style={s.sheetBackdrop}
          activeOpacity={1}
          onPress={() => setChanSheetOpen(false)}
        >
          <View style={s.sheet}>
            <View style={s.sheetHeader}>
              <Text style={s.sectionTitle}>{"// set channel"}</Text>
              <TouchableOpacity onPress={() => setChanSheetOpen(false)} testID="btn-channel-close">
                <MaterialCommunityIcons name="close" size={18} color={C.green} />
              </TouchableOpacity>
            </View>
            <Text style={s.helperFine}>2.4 GHz</Text>
            <View style={s.chipRow}>
              {CHANNELS_24.map((ch) => (
                <ChannelChip key={ch} ch={ch}
                  active={state?.info.channel === String(ch)}
                  busy={busy === `ch ${ch}`}
                  onPress={() => { handleSetChannel(ch); setChanSheetOpen(false); }}
                  disabled={disabled}
                />
              ))}
            </View>
            <Text style={[s.helperFine, { marginTop: 8 }]}>5 GHz</Text>
            <View style={s.chipRow}>
              {CHANNELS_5.map((ch) => (
                <ChannelChip key={ch} ch={ch}
                  active={state?.info.channel === String(ch)}
                  busy={busy === `ch ${ch}`}
                  onPress={() => { handleSetChannel(ch); setChanSheetOpen(false); }}
                  disabled={disabled}
                />
              ))}
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────
function ToggleRow({
  label, sub, state, busy, onPress, disabled, master,
}: {
  label: string; sub: string; state: ToggleState; busy: boolean;
  onPress: () => void; disabled?: boolean; master?: boolean;
}) {
  // Dot color mirrors the mcp node status pill: green = on, dim = off,
  // yellow = probing/unknown/busy. For a `master` interop switch, ON is
  // shown RED (it means the Android WiFi stack is still fighting Kali).
  const onColor = master ? C.red : C.green;
  const dotColor =
    state === "on" ? onColor :
    state === "off" ? C.textDim :
    C.yellow;
  const glowShown = state === "on" || busy;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || busy}
      activeOpacity={0.7}
      style={[
        s.toggleRow,
        master && { borderColor: state === "on" ? C.red : C.greenDim },
        disabled && { opacity: 0.5 },
      ]}
    >
      <View style={s.dotWrap}>
        {glowShown && <View style={[s.dotGlow, { backgroundColor: dotColor }]} />}
        <View style={[s.dot, { backgroundColor: dotColor }]} />
      </View>
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={s.toggleLabel}>{label}</Text>
        <Text style={[s.toggleSub, master && state === "on" && { color: C.red }]}>{sub}</Text>
      </View>
      <View style={[s.toggleTrack, state === "on" && { backgroundColor: master ? "#5a1020" : C.greenDim }]}>
        <View style={[s.toggleKnob, {
          left: state === "on" ? 20 : 2,
          backgroundColor: busy ? C.yellow : state === "on" ? onColor : C.text,
        }]} />
      </View>
    </TouchableOpacity>
  );
}

function HudCell({ k, v, color, wide }: { k: string; v: string; color: string; wide?: boolean }) {
  return (
    <View style={{ width: wide ? "100%" : "50%", flexDirection: "row", marginBottom: 3 }}>
      <Text style={[s.helperFine, { color: C.textDim, width: 42 }]}>{k}</Text>
      <Text style={[s.helperFine, { color, flex: 1 }]} numberOfLines={1}>{v}</Text>
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
  sectionRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    marginTop: 16,
  },
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
  hudCard: {
    paddingHorizontal: 12, paddingVertical: 10,
    borderWidth: 1, borderColor: C.border, borderRadius: 4,
    backgroundColor: C.panel2, marginTop: 6,
  },
  readoutRow: {
    flexDirection: "row", alignItems: "center", gap: 18,
    paddingHorizontal: 14, paddingVertical: 12,
    borderWidth: 1, borderColor: C.border, borderRadius: 4,
    backgroundColor: C.panel, marginTop: 6,
  },
  readoutText: { color: C.text, fontFamily: MONO, fontSize: 13, flexShrink: 1 },
  sheetBackdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: C.panel, borderTopWidth: 1, borderColor: C.border,
    borderTopLeftRadius: 10, borderTopRightRadius: 10, padding: 16, paddingBottom: 28,
  },
  sheetHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    marginBottom: 10,
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
