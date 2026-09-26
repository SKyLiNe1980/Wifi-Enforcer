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
import { Modal, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { execReal, HAS_NATIVE_ROOT } from "../lib/rootShell";
import { kvGet, kvSet } from "../lib/localDb";

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
  info: {
    mode?: string; channel?: string; txpower?: string; mac?: string;
    freq?: string; band?: string; signal?: string; quality?: string; bitrate?: string;
  };
  counters: { rxBytes: number; txBytes: number; rxPackets: number; txPackets: number; errs: number };
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
    `echo "=== iwconfig ==="`,
    `iwconfig '${iface}' 2>/dev/null || echo NO_IWCONFIG`,
    `echo "=== netdev ==="`,
    `grep '${iface}:' /proc/net/dev 2>/dev/null || echo NO_NETDEV`,
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

  // iwconfig: frequency/band, signal level, link quality, bit rate
  const iwcBlock = (out.match(/=== iwconfig ===[\s\S]*?(?====|$)/) || [""])[0];
  const freqMatch = iwcBlock.match(/Frequency[:=]\s*([\d.]+)\s*GHz/i);
  const freqGhz = freqMatch ? parseFloat(freqMatch[1]) : undefined;
  const signalMatch = iwcBlock.match(/Signal level[:=]\s*(-?\d+)\s*dBm/i);
  const qualityMatch = iwcBlock.match(/Link Quality[:=]\s*(\d+\/\d+)/i);
  const bitrateMatch = iwcBlock.match(/Bit Rate[:=]\s*([\d.]+\s*[GM]b\/s)/i);

  // /proc/net/dev counters: "iface: rxBytes rxPkts rxErrs ... txBytes txPkts txErrs ..."
  const netdevBlock = (out.match(/=== netdev ===[\s\S]*?(?====|$)/) || [""])[0];
  const ndLine = netdevBlock.split(/\r?\n/).find((l) => l.includes(`${iface}:`)) || "";
  const nd = ndLine.replace(/^.*?:/, "").trim().split(/\s+/).map((x) => parseInt(x, 10) || 0);
  const counters = {
    rxBytes: nd[0] || 0, rxPackets: nd[1] || 0,
    txBytes: nd[8] || 0, txPackets: nd[9] || 0,
    errs: (nd[2] || 0) + (nd[10] || 0),
  };

  return {
    wifiOn, ifaceUp, regDomain, monitor,
    info: {
      mode,
      channel: channelMatch?.[1],
      txpower: txpowerMatch?.[1],
      mac: macMatch?.[1],
      freq: freqGhz ? `${freqGhz} GHz` : undefined,
      band: freqGhz ? (freqGhz >= 5 ? "5 GHz" : "2.4 GHz") : undefined,
      signal: signalMatch ? `${signalMatch[1]} dBm` : undefined,
      quality: qualityMatch?.[1],
      bitrate: bitrateMatch?.[1],
    },
    counters,
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
  onCountryChange?: (cc: string) => void;
  disabled?: boolean;
};

const PROFILE_SLOTS = ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO"] as const;
type WlanProfile = {
  set: boolean; iface?: string; monitor?: boolean;
  channel?: string; country?: string; txpower?: string;
};
const EMPTY_PROFILES: WlanProfile[] = PROFILE_SLOTS.map(() => ({ set: false }));
const PROFILES_KEY = "wlan_radio_profiles";

export default function WlanControl({
  iface, country, onIfaceChange, onExecCommand, onCountryChange, disabled,
}: Props) {
  const [detected, setDetected] = useState<string[]>([]);
  const [state, setState] = useState<Awaited<ReturnType<typeof probeAllStates>> | null>(null);
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [chanSheetOpen, setChanSheetOpen] = useState(false);
  const [ifaceSheetOpen, setIfaceSheetOpen] = useState(false);
  // regdom / txpower fill-box editors
  const [editField, setEditField] = useState<null | "regdom" | "txpower">(null);
  const [editVal, setEditVal] = useState("");
  // 5 radio-profile slots (A–E), persisted locally
  const [profiles, setProfiles] = useState<WlanProfile[]>(EMPTY_PROFILES);
  const [selProfile, setSelProfile] = useState<number | null>(null);
  // live RX/TX rate sampling (bytes + timestamp of previous poll)
  const rateRef = useRef<{ rx: number; tx: number; ts: number } | null>(null);
  const [rates, setRates] = useState<{ rx: number; tx: number }>({ rx: 0, tx: 0 });
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Load saved profiles once on mount
  useEffect(() => {
    kvGet(PROFILES_KEY).then((raw) => {
      if (!raw || !mountedRef.current) return;
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length === PROFILE_SLOTS.length) setProfiles(arr);
      } catch { /* ignore corrupt */ }
    });
  }, []);

  const applySnap = useCallback((snap: Awaited<ReturnType<typeof probeAllStates>>) => {
    if (!mountedRef.current) return;
    if (snap.interfaces.length > 0) setDetected(snap.interfaces);
    // Compute RX/TX byte-rates from the delta since the previous sample.
    const now = Date.now();
    const prev = rateRef.current;
    if (prev) {
      const dt = (now - prev.ts) / 1000;
      if (dt > 0) {
        setRates({
          rx: Math.max(0, (snap.counters.rxBytes - prev.rx) / dt),
          tx: Math.max(0, (snap.counters.txBytes - prev.tx) / dt),
        });
      }
    }
    rateRef.current = { rx: snap.counters.rxBytes, tx: snap.counters.txBytes, ts: now };
    setState(snap);
  }, []);

  const refresh = useCallback(async () => {
    if (!HAS_NATIVE_ROOT) return;
    setProbing(true);
    try {
      applySnap(await probeAllStates(iface, country));
    } catch (e) {
      console.warn("[WlanControl] probe failed:", e);
    } finally {
      if (mountedRef.current) setProbing(false);
    }
  }, [iface, country, applySnap]);

  // Silent poll — NO probing/spinner toggle, so the status card just updates
  // its numbers in place with zero blink/stutter on each 2s tick.
  const silentRefresh = useCallback(async () => {
    if (!HAS_NATIVE_ROOT) return;
    try {
      applySnap(await probeAllStates(iface, country));
    } catch { /* transient — keep last-known values */ }
  }, [iface, country, applySnap]);

  // Initial probe on mount + on iface/country change (with spinner).
  useEffect(() => { refresh(); }, [refresh]);

  // Live 2s status poll while this component is mounted (i.e. WLAN tab
  // focused — it unmounts when you switch tabs). Overlap-guarded so a slow
  // root call never stacks.
  useEffect(() => {
    if (!HAS_NATIVE_ROOT) return;
    let inFlight = false;
    const id = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      await silentRefresh();
      inFlight = false;
    }, 2000);
    return () => clearInterval(id);
  }, [silentRefresh]);

  const runAndRefresh = useCallback(async (cmd: string, label: string) => {
    setBusy(label);
    try {
      await onExecCommand(cmd, label);
      // Small delay so the state change lands before we re-probe (silent, no blink).
      await new Promise((r) => setTimeout(r, 500));
      await silentRefresh();
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [onExecCommand, silentRefresh]);

  // ─── Control handlers ──────────────────────────────────────────────
  const handleMonitorToggle = useCallback(() => {
    // Monitor mode needs iface down first. Chain in one shell so partial
    // states don't leave the iface in a weird spot.
    const target = state?.monitor === "on" ? "managed" : "monitor";
    const cmd = `ifconfig ${iface} down && iw dev ${iface} set type ${target} && ifconfig ${iface} up`;
    runAndRefresh(cmd, `monitor ${target}`);
  }, [state?.monitor, iface, runAndRefresh]);

  const handleSetChannel = useCallback((ch: number) => {
    runAndRefresh(`iw dev ${iface} set channel ${ch}`, `ch ${ch}`);
  }, [iface, runAndRefresh]);

  const handleSetRegdom = useCallback((cc: string) => {
    const v = (cc || "00").trim().toUpperCase();
    // Keep parent country state in sync so the pill + regDomain "on/off"
    // detection (which compares against `country`) stay accurate.
    if (v !== "00") onCountryChange?.(v);
    runAndRefresh(`iw reg set ${v}`, `reg ${v}`);
  }, [runAndRefresh, onCountryChange]);

  const handleSetTxpower = useCallback((dbm: string) => {
    const n = parseFloat(dbm);
    if (!isFinite(n)) return;
    // iw takes milli-dBm for fixed txpower
    runAndRefresh(`iw dev ${iface} set txpower fixed ${Math.round(n * 100)}`, `tx ${n}`);
  }, [iface, runAndRefresh]);

  const submitEdit = useCallback(() => {
    if (editField === "regdom") handleSetRegdom(editVal);
    else if (editField === "txpower") handleSetTxpower(editVal);
    setEditField(null); setEditVal("");
  }, [editField, editVal, handleSetRegdom, handleSetTxpower]);

  // ─── Radio profiles (5 slots A–E) ──────────────────────────────────
  const persistProfiles = useCallback((next: WlanProfile[]) => {
    setProfiles(next);
    kvSet(PROFILES_KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  const saveProfileToSlot = useCallback((idx: number) => {
    const p: WlanProfile = {
      set: true,
      iface,
      monitor: state?.monitor === "on",
      channel: state?.info.channel,
      country: state?.regDomain === "on" ? country : undefined,
      txpower: state?.info.txpower,
    };
    persistProfiles(profiles.map((x, i) => (i === idx ? p : x)));
  }, [iface, state, country, profiles, persistProfiles]);

  const applyProfile = useCallback((p: WlanProfile) => {
    if (!p.set) return;
    if (p.iface && p.iface !== iface) onIfaceChange(p.iface);
    const tgt = p.iface || iface;
    const seq: string[] = [];
    if (p.country) seq.push(`iw reg set ${p.country}`);
    seq.push(`ifconfig ${tgt} down`);
    seq.push(`iw dev ${tgt} set type ${p.monitor ? "monitor" : "managed"}`);
    seq.push(`ifconfig ${tgt} up`);
    if (p.channel) seq.push(`iw dev ${tgt} set channel ${p.channel}`);
    if (p.txpower) {
      const n = parseFloat(p.txpower);
      if (isFinite(n)) seq.push(`iw dev ${tgt} set txpower fixed ${Math.round(n * 100)}`);
    }
    runAndRefresh(seq.join(" && "), "apply profile");
  }, [iface, onIfaceChange, runAndRefresh]);

  const handleProfileTap = useCallback((idx: number) => {
    setSelProfile(idx);
    const p = profiles[idx];
    if (p?.set) applyProfile(p);
  }, [profiles, applyProfile]);

  const ifaceList = useMemo(() => {
    // Merge detected list with the current selection so it's always shown
    // even if `iw dev` momentarily misses it.
    const set = new Set(detected);
    if (iface) set.add(iface);
    return Array.from(set).sort();
  }, [detected, iface]);

  return (
    <View style={s.root}>
      {/* ── §1 radio profile — interface-config menu bar ── */}
      <Text style={s.sectionTitle}>{"// radio profile"}</Text>
      <View style={s.menuBar}>
        <Text style={s.bracket}>[</Text>
        <MenuPill label={iface || "wlan?"} on={!!iface} busy={probing}
          onPress={() => setIfaceSheetOpen(true)} disabled={disabled} />
        <MenuPill label="MON" on={state?.monitor === "on"} busy={(busy || "").startsWith("monitor")}
          onPress={handleMonitorToggle} disabled={disabled} />
        <MenuPill label={state?.info.channel ? `CH ${state.info.channel}` : "CH"} on={!!state?.info.channel}
          busy={(busy || "").startsWith("ch ")} onPress={() => setChanSheetOpen(true)} disabled={disabled} />
        <MenuPill label={state?.regDomain === "on" ? (country || "SET") : state?.regDomain === "off" ? "00" : "REG"}
          on={state?.regDomain === "on"} busy={(busy || "").startsWith("reg ")}
          onPress={() => { setEditField("regdom"); setEditVal(country || ""); }} disabled={disabled} />
        <MenuPill label={state?.info.txpower ? state.info.txpower.replace(/\s*dBm/i, "") : "TX"}
          on={!!state?.info.txpower} busy={(busy || "").startsWith("tx ")}
          onPress={() => { setEditField("txpower"); setEditVal((state?.info.txpower || "").replace(/[^\d.]/g, "")); }}
          disabled={disabled} />
        <Text style={s.bracket}>]</Text>
      </View>

      {/* ── §2 profiles — 5 slots A–E + SAVE ── */}
      <View style={[s.sectionRow, { marginTop: 18 }]}>
        <Text style={s.sectionTitle}>{"// profiles"}</Text>
        <TouchableOpacity
          testID="btn-profile-save"
          onPress={() => selProfile !== null && saveProfileToSlot(selProfile)}
          disabled={disabled || selProfile === null}
          style={[s.saveBtn, selProfile === null && { opacity: 0.4 }]}
        >
          <MaterialCommunityIcons name="content-save" size={13} color={C.green} />
          <Text style={[s.chipText, { color: C.green, marginLeft: 4 }]}>SAVE</Text>
        </TouchableOpacity>
      </View>
      <View style={s.profileRow}>
        {PROFILE_SLOTS.map((name, i) => {
          const p = profiles[i];
          const sel = selProfile === i;
          return (
            <TouchableOpacity
              key={name}
              testID={`profile-${name}`}
              onPress={() => handleProfileTap(i)}
              disabled={disabled}
              style={[s.profileBtn, sel && s.profileBtnSel, p?.set && !sel && { borderColor: C.greenDim }]}
            >
              <Text
                style={[s.profileText, sel && { color: C.bg }, p?.set && !sel && { color: C.green }]}
                numberOfLines={1}
                allowFontScaling={false}
              >
                {name}
              </Text>
              {p?.set && <View style={[s.profileDot, { backgroundColor: sel ? C.bg : C.green }]} />}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── §3 status — merged live + channel readout ── */}
      <Text style={[s.sectionTitle, { marginTop: 18 }]}>{"// status"}</Text>
      <View style={s.statusCard}>
        {state ? (
          <>
            <View style={s.statusGrid}>
              <StatCell k="mode" v={state.info.mode || "—"} color={state.info.mode === "monitor" ? C.magenta : C.cyan} />
              <StatCell k="channel" v={state.info.channel || "—"} color={C.cyan} />
              <StatCell k="band" v={state.info.band || "—"} color={C.cyan} />
              <StatCell k="freq" v={state.info.freq || "—"} color={C.cyan} />
              <StatCell k="txpwr" v={state.info.txpower || "—"} color={C.cyan} />
              <StatCell k="signal" v={state.info.signal || "—"}
                color={(() => { const n = parseInt(state.info.signal || "", 10); return isNaN(n) ? C.cyan : n > -60 ? C.green : n > -75 ? C.yellow : C.red; })()} />
              <StatCell k="quality" v={state.info.quality || "—"} color={C.cyan} />
              <StatCell k="link" v={state.info.bitrate || "—"} color={C.cyan} />
              <StatCell k="mac" v={state.info.mac || "—"} color={C.textDim} wide />
            </View>
            <View style={s.statusLive}>
              <Text style={s.liveText}>RX <Text style={{ color: C.green }}>{fmtRate(rates.rx)}</Text></Text>
              <Text style={s.liveText}>TX <Text style={{ color: C.green }}>{fmtRate(rates.tx)}</Text></Text>
              <Text style={s.liveText}>PKT <Text style={{ color: C.cyan }}>{(state.counters.rxPackets + state.counters.txPackets).toLocaleString()}</Text></Text>
              <Text style={s.liveText}>ERR <Text style={{ color: state.counters.errs > 0 ? C.red : C.cyan }}>{state.counters.errs}</Text></Text>
            </View>
          </>
        ) : (
          <Text style={s.helperFine}>… probing</Text>
        )}
      </View>

      {/* Interface picker sheet */}
      <Modal visible={ifaceSheetOpen} transparent animationType="none" onRequestClose={() => setIfaceSheetOpen(false)}>
        <TouchableOpacity style={s.sheetBackdrop} activeOpacity={1} onPress={() => setIfaceSheetOpen(false)}>
          <View style={s.sheet}>
            <View style={s.sheetHeader}>
              <Text style={s.sectionTitle}>{"// select interface"}</Text>
              <TouchableOpacity onPress={() => setIfaceSheetOpen(false)}>
                <MaterialCommunityIcons name="close" size={18} color={C.green} />
              </TouchableOpacity>
            </View>
            {ifaceList.length === 0 && <Text style={s.helperFine}>none detected via iw dev</Text>}
            {ifaceList.map((n) => (
              <TouchableOpacity key={n} testID={`iface-opt-${n}`}
                style={[s.optRow, n === iface && { borderColor: C.green }]}
                onPress={() => { onIfaceChange(n); setIfaceSheetOpen(false); }}>
                <MaterialCommunityIcons name="wifi" size={14} color={n === iface ? C.green : C.textDim} />
                <Text style={[s.optText, n === iface && { color: C.green }]}>{n}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity onPress={refresh} style={[s.optRow, { borderColor: C.cyan }]}>
              <MaterialCommunityIcons name="refresh" size={14} color={C.cyan} />
              <Text style={[s.optText, { color: C.cyan }]}>{probing ? "scanning…" : "re-scan"}</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* regdom / txpower fill-box editor */}
      <Modal visible={editField !== null} transparent animationType="none" onRequestClose={() => setEditField(null)}>
        <TouchableOpacity style={s.sheetBackdrop} activeOpacity={1} onPress={() => setEditField(null)}>
          <View style={s.sheet}>
            <View style={s.sheetHeader}>
              <Text style={s.sectionTitle}>{editField === "regdom" ? "// set reg domain" : "// set tx power"}</Text>
              <TouchableOpacity onPress={() => setEditField(null)}>
                <MaterialCommunityIcons name="close" size={18} color={C.green} />
              </TouchableOpacity>
            </View>
            <TextInput
              testID="input-wlan-edit"
              value={editVal}
              onChangeText={setEditVal}
              autoFocus
              autoCapitalize={editField === "regdom" ? "characters" : "none"}
              keyboardType={editField === "txpower" ? "numbers-and-punctuation" : "default"}
              placeholder={editField === "regdom" ? "country e.g. NL / US / 00" : "dBm e.g. 20 / 30"}
              placeholderTextColor={C.textDim}
              style={s.editInput}
              onSubmitEditing={submitEdit}
            />
            <TouchableOpacity testID="btn-wlan-edit-apply" onPress={submitEdit} style={s.applyBtn}>
              <Text style={[s.chipText, { color: C.bg, fontWeight: "800" }]}>APPLY</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

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
function fmtRate(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec < 1) return "0 B/s";
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
}

/** A single control in the §1 radio-profile menu bar. Green when its state
 *  is active/set, dim-outlined when off/unset — so the whole bar reads as a
 *  live snapshot of the radio config you can tap into. */
function MenuPill({ label, on, busy, onPress, disabled }: {
  label: string; on?: boolean; busy?: boolean; onPress: () => void; disabled?: boolean;
}) {
  const color = busy ? C.yellow : on ? C.bg : C.textDim;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || busy}
      activeOpacity={0.7}
      style={[
        s.menuPill,
        on && { backgroundColor: C.green, borderColor: C.green },
        busy && { borderColor: C.yellow },
      ]}
    >
      <Text style={[s.menuPillText, { color }]} numberOfLines={1} allowFontScaling={false}>{label}</Text>
    </TouchableOpacity>
  );
}

function StatCell({ k, v, color, wide }: { k: string; v: string; color: string; wide?: boolean }) {
  return (
    <View style={[s.statCell, wide && { width: "100%" }]}>
      <Text style={s.statKey}>{k}</Text>
      <Text style={[s.statVal, { color }]} numberOfLines={1}>{v}</Text>
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
  sectionTitle: { color: C.green, fontFamily: MONO, fontSize: 12, fontWeight: "700", letterSpacing: 1, includeFontPadding: false, textAlignVertical: "center" },
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
  chipText: { color: C.green, fontFamily: MONO, fontSize: 12, fontWeight: "600", includeFontPadding: false },

  // §1 menu bar
  menuBar: {
    flexDirection: "row", alignItems: "center", marginTop: 8,
    borderWidth: 1, borderColor: C.border, borderRadius: 4,
    backgroundColor: C.panel2, paddingVertical: 12, paddingHorizontal: 6, gap: 5,
  },
  bracket: { color: C.greenDim, fontFamily: MONO, fontSize: 22, fontWeight: "700" },
  menuPill: {
    flex: 1, alignItems: "center", justifyContent: "center",
    paddingHorizontal: 4, paddingVertical: 9,
    borderWidth: 1, borderColor: C.border, borderRadius: 3, backgroundColor: C.panel,
  },
  menuPillText: { fontFamily: MONO, fontSize: 12, fontWeight: "700", includeFontPadding: false },

  // §2 profiles
  saveBtn: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 12, paddingVertical: 6,
    borderWidth: 1, borderColor: C.green, borderRadius: 3, backgroundColor: C.panel,
  },
  profileRow: { flexDirection: "row", marginTop: 8, gap: 6 },
  profileBtn: {
    flex: 1, alignItems: "center", justifyContent: "center",
    paddingVertical: 12, paddingHorizontal: 2,
    borderWidth: 1, borderColor: C.border, borderRadius: 3, backgroundColor: C.panel,
  },
  profileBtnSel: { backgroundColor: C.green, borderColor: C.green },
  profileText: { color: C.textDim, fontFamily: MONO, fontSize: 11, fontWeight: "700", includeFontPadding: false },
  profileDot: { width: 5, height: 5, borderRadius: 3, marginTop: 4 },

  // §3 status
  statusCard: {
    padding: 12, borderWidth: 1, borderColor: C.border, borderRadius: 4,
    backgroundColor: C.panel2, marginTop: 6,
  },
  statusGrid: { flexDirection: "row", flexWrap: "wrap" },
  statCell: { width: "50%", flexDirection: "row", alignItems: "center", marginBottom: 5 },
  statKey: { color: C.textDim, fontFamily: MONO, fontSize: 10, width: 58, includeFontPadding: false },
  statVal: { fontFamily: MONO, fontSize: 12, fontWeight: "700", flex: 1, includeFontPadding: false },
  statusLive: {
    flexDirection: "row", flexWrap: "wrap", gap: 14,
    marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.border,
  },
  liveText: { color: C.textDim, fontFamily: MONO, fontSize: 11, includeFontPadding: false },

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
  optRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 12, paddingVertical: 12, marginTop: 6,
    borderWidth: 1, borderColor: C.border, borderRadius: 4, backgroundColor: C.panel2,
  },
  optText: { color: C.text, fontFamily: MONO, fontSize: 13, fontWeight: "700" },
  editInput: {
    color: C.green, fontFamily: MONO, fontSize: 15,
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 4,
    paddingHorizontal: 12, paddingVertical: 12, marginTop: 4,
  },
  applyBtn: {
    alignItems: "center", justifyContent: "center", marginTop: 12,
    paddingVertical: 12, borderRadius: 4, backgroundColor: C.green,
  },
});
