/**
 * SwatSettings — the SWAT connection/keep-alive config panel, extracted from
 * the old SWAT-tab gear cog and relocated to Settings → SWAT.
 * Host/port/nick/channel · TLS · SASL · autoconnect · alerts · notification /
 * battery / wakelock permissions. Saving reconnects the IRC control plane.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Platform, Switch,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { HAS_SWAT_BUS, busToggleWake, busIsWakeHeld } from "../lib/swatBus";
import {
  checkNotifPerm, requestNotifPerm, openAppSettings,
  isBatteryExempt, requestBatteryExempt, type PermState,
} from "../lib/swatPerms";
import {
  connectSwat, disconnectSwat, loadSwatConfig, saveSwatConfig,
  readSaslPassword, writeSaslPassword, type SwatConfig,
} from "../lib/swatIrc";

const C = {
  surface: "#04070a", panel: "#0a1116", panel2: "#0e1820", border: "#163041",
  green: "#00ff66", amber: "#ffd400", cyan: "#3ad7ff", red: "#ff3860",
  grey: "#6c8a82", text: "#cfeadb", dim: "#6c8a82",
};
const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

export default function SwatSettings() {
  const [cfg, setCfg] = useState<SwatConfig | null>(null);
  const [saslPw, setSaslPw] = useState("");
  const [saslPwSet, setSaslPwSet] = useState(false);
  const [notifPerm, setNotifPerm] = useState<PermState>("denied");
  const [battOk, setBattOk] = useState(false);
  const [wakeHeld, setWakeHeld] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<any>(null);

  const refreshStatus = useCallback(async () => {
    const [n, b, w] = await Promise.all([checkNotifPerm(), isBatteryExempt(), busIsWakeHeld()]);
    setNotifPerm(n); setBattOk(b); setWakeHeld(w);
  }, []);

  useEffect(() => {
    loadSwatConfig().then(setCfg);
    readSaslPassword().then((pw) => setSaslPwSet(pw.length > 0));
    refreshStatus();
    return () => { if (savedTimer.current) clearTimeout(savedTimer.current); };
  }, [refreshStatus]);

  const patch = (p: Partial<SwatConfig>) => setCfg((c) => (c ? { ...c, ...p } : c));

  const onGrantNotif = useCallback(async () => {
    if (notifPerm === "blocked") { await openAppSettings(); return; }
    const res = await requestNotifPerm();
    setNotifPerm(res);
    if (res === "blocked") await openAppSettings();
  }, [notifPerm]);

  const onFixBattery = useCallback(async () => {
    await requestBatteryExempt();
    setTimeout(() => { isBatteryExempt().then(setBattOk); }, 1500);
  }, []);

  const onToggleWake = useCallback(async () => {
    await busToggleWake();
    setTimeout(() => { busIsWakeHeld().then(setWakeHeld); }, 300);
  }, []);

  const saveCfg = useCallback(async () => {
    if (!cfg) return;
    await saveSwatConfig(cfg);
    if (saslPw.trim()) {
      await writeSaslPassword(saslPw.trim());
      setSaslPwSet(true); setSaslPw("");
    } else if (!cfg.saslAccount.trim()) {
      await writeSaslPassword(""); setSaslPwSet(false);
    }
    disconnectSwat();
    connectSwat();
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 2000);
  }, [cfg, saslPw]);

  const PermRow = ({ icon, label, ok, okText, badText, action, onPress }: {
    icon: any; label: string; ok: boolean; okText: string; badText: string; action: string; onPress: () => void;
  }) => (
    <View style={s.permRow}>
      <MaterialCommunityIcons name={icon} size={16} color={ok ? C.green : C.amber} />
      <Text style={s.permLabel} numberOfLines={1}>{label}</Text>
      <Text style={[s.permState, { color: ok ? C.green : C.amber }]}>{ok ? okText : badText}</Text>
      <TouchableOpacity onPress={onPress} style={[s.permBtn, { borderColor: ok ? C.green : C.amber }]}>
        <Text style={[s.permBtnTxt, { color: ok ? C.green : C.amber }]}>{action}</Text>
      </TouchableOpacity>
    </View>
  );

  if (!cfg) {
    return <View style={{ padding: 24 }}><Text style={s.lbl}>loading swat config…</Text></View>;
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <Text style={s.section}>{"// connection"}</Text>
      <View style={s.card}>
        <View style={s.row}>
          <View style={{ flex: 2, marginRight: 8 }}>
            <Text style={s.lbl}>HOST</Text>
            <TextInput style={s.input} value={cfg.host} onChangeText={(t) => patch({ host: t })}
              autoCapitalize="none" autoCorrect={false} placeholderTextColor={C.dim} />
          </View>
          <View style={{ width: 84 }}>
            <Text style={s.lbl}>PORT</Text>
            <TextInput style={s.input} value={String(cfg.port)} keyboardType="numeric"
              onChangeText={(t) => patch({ port: parseInt(t || "0", 10) || 0 })} placeholderTextColor={C.dim} />
          </View>
        </View>
        <View style={[s.row, { marginTop: 8 }]}>
          <View style={{ flex: 1, marginRight: 8 }}>
            <Text style={s.lbl}>NICK</Text>
            <TextInput style={s.input} value={cfg.nick} onChangeText={(t) => patch({ nick: t })}
              autoCapitalize="none" autoCorrect={false} placeholderTextColor={C.dim} />
          </View>
          <View style={{ width: 120 }}>
            <Text style={s.lbl}>CHANNEL</Text>
            <TextInput style={s.input} value={cfg.channel} onChangeText={(t) => patch({ channel: t })}
              autoCapitalize="none" autoCorrect={false} placeholderTextColor={C.dim} />
          </View>
        </View>
        <View style={[s.row, { alignItems: "center", marginTop: 10 }]}>
          <Switch value={cfg.tls} onValueChange={(v) => patch({ tls: v })}
            trackColor={{ false: C.border, true: "#1a3a2a" }} thumbColor={cfg.tls ? C.green : C.dim} />
          <Text style={s.lbl}>  secure wss (:7779)</Text>
        </View>
      </View>

      <Text style={[s.section, { marginTop: 18 }]}>{"// identity · sasl"}</Text>
      <View style={s.card}>
        <View style={s.row}>
          <View style={{ flex: 1, marginRight: 8 }}>
            <Text style={s.lbl}>SASL ACCOUNT (blank = off)</Text>
            <TextInput style={s.input} value={cfg.saslAccount} onChangeText={(t) => patch({ saslAccount: t })}
              autoCapitalize="none" autoCorrect={false} placeholder="ergo account" placeholderTextColor={C.dim} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.lbl}>SASL PASSWORD</Text>
            <TextInput style={s.input} value={saslPw} onChangeText={setSaslPw}
              secureTextEntry autoCapitalize="none" autoCorrect={false}
              placeholder={saslPwSet ? "•••••• (saved)" : "not set"} placeholderTextColor={C.dim} />
          </View>
        </View>
      </View>

      <Text style={[s.section, { marginTop: 18 }]}>{"// behaviour"}</Text>
      <View style={s.card}>
        <View style={[s.row, { alignItems: "center" }]}>
          <Switch value={cfg.autoconnect} onValueChange={(v) => patch({ autoconnect: v })}
            trackColor={{ false: C.border, true: "#1a3a2a" }} thumbColor={cfg.autoconnect ? C.green : C.dim} />
          <Text style={s.lbl}>  autoconnect on open</Text>
        </View>
        <View style={[s.row, { alignItems: "center", marginTop: 10 }]}>
          <Switch value={cfg.alertsEnabled} onValueChange={(v) => patch({ alertsEnabled: v })}
            trackColor={{ false: C.border, true: "#1a3a2a" }} thumbColor={cfg.alertsEnabled ? C.green : C.dim} />
          <Text style={s.lbl}>  alert on @mention · MISSION · HALT</Text>
        </View>
      </View>

      {HAS_SWAT_BUS && (
        <>
          <Text style={[s.section, { marginTop: 18 }]}>{"// keep-alive & permissions"}</Text>
          <View style={s.card}>
            <PermRow icon="bell-ring" label="Notifications" ok={notifPerm === "granted"} okText="granted"
              badText={notifPerm === "blocked" ? "blocked" : "denied"}
              action={notifPerm === "blocked" ? "SETTINGS" : "GRANT"} onPress={onGrantNotif} />
            <PermRow icon="battery-heart-variant" label="Battery optimisation" ok={battOk} okText="exempt"
              badText="optimised" action="FIX" onPress={onFixBattery} />
            <PermRow icon="lock" label="Wakelock (CPU on, screen off)" ok={wakeHeld} okText="acquired"
              badText="off" action={wakeHeld ? "RELEASE" : "ACQUIRE"} onPress={onToggleWake} />
          </View>
        </>
      )}

      <TouchableOpacity onPress={saveCfg} style={s.saveBtn}>
        <MaterialCommunityIcons name={saved ? "check-bold" : "lan-connect"} size={16} color={C.surface} />
        <Text style={s.saveTxt}>{saved ? "SAVED · RECONNECTING" : "SAVE & RECONNECT"}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  section: { fontFamily: MONO, color: C.dim, fontSize: 12, letterSpacing: 0.5, marginBottom: 8 },
  card: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: 8, padding: 12 },
  row: { flexDirection: "row" },
  lbl: { fontFamily: MONO, color: C.dim, fontSize: 10, marginBottom: 3 },
  input: {
    fontFamily: MONO, color: C.text, fontSize: 12, backgroundColor: C.panel2,
    borderWidth: 1, borderColor: C.border, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 7,
  },
  permRow: { flexDirection: "row", alignItems: "center", paddingVertical: 7 },
  permLabel: { fontFamily: MONO, color: C.text, fontSize: 11, marginLeft: 8, flex: 1 },
  permState: { fontFamily: MONO, fontSize: 10, marginRight: 8 },
  permBtn: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 4 },
  permBtnTxt: { fontFamily: MONO, fontSize: 10, fontWeight: "700" },
  saveBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: C.green, borderRadius: 6, paddingVertical: 13, marginTop: 20,
  },
  saveTxt: { fontFamily: MONO, color: C.surface, fontSize: 13, fontWeight: "800", letterSpacing: 0.5 },
});
