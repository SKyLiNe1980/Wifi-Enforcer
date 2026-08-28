/* eslint-disable react/jsx-no-comment-textnodes */
/**
 * SwatTab — the SWAT IRC control-plane cockpit (Phase A + basic send).
 * Connection LED + host/nick strip · roster chips · verb-coloured live feed ·
 * bottom send box. Config lives in an inline gear panel (host/port/nick/chan).
 */
import React, { useEffect, useRef, useState, useSyncExternalStore, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Platform, Switch,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import {
  subscribeSwat, getSwatState, connectSwat, disconnectSwat, swatSend,
  loadSwatConfig, saveSwatConfig, isCommander, parseIrcColored,
  type SwatConfig, type EventColor,
} from "../lib/swatIrc";

const C = {
  surface: "#04070a", panel: "#0a1116", panel2: "#0e1820", border: "#163041",
  green: "#00ff66", amber: "#ffd400", cyan: "#3ad7ff", red: "#ff3860",
  grey: "#6c8a82", text: "#cfeadb", dim: "#6c8a82",
};
const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });
const COL: Record<EventColor, string> = { grey: C.grey, yellow: C.amber, green: C.green, red: C.red };

function ts(t: number) {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function SwatTab() {
  const insets = useSafeAreaInsets();
  const st = useSyncExternalStore(subscribeSwat, getSwatState);
  const [cfg, setCfg] = useState<SwatConfig | null>(null);
  const [showCfg, setShowCfg] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [draft, setDraft] = useState("");
  const feedRef = useRef<ScrollView>(null);

  useEffect(() => {
    loadSwatConfig().then((c) => {
      setCfg(c);
      if (c.autoconnect && getSwatState().status === "down") connectSwat();
    });
    return () => { /* keep connection alive across tab switches */ };
  }, []);

  useEffect(() => {
    if (autoScroll) requestAnimationFrame(() => feedRef.current?.scrollToEnd({ animated: true }));
  }, [st.events, autoScroll]);

  const ledColor = st.status === "connected" ? C.green : st.status === "connecting" ? C.amber : C.red;
  const commander = isCommander(st.nick || cfg?.nick || "");

  const saveCfg = useCallback(async () => {
    if (!cfg) return;
    await saveSwatConfig(cfg);
    setShowCfg(false);
    disconnectSwat();
    connectSwat();
  }, [cfg]);

  const send = useCallback(() => {
    const t = draft.trim();
    if (!t) return;
    swatSend(t);
    setDraft("");
  }, [draft]);

  const patch = (p: Partial<SwatConfig>) => setCfg((c) => (c ? { ...c, ...p } : c));

  return (
    <View style={[styles.root, { paddingTop: insets.top ? 0 : 6 }]}>
      {/* TOP STRIP */}
      <View style={styles.topStrip}>
        <View style={[styles.led, { backgroundColor: ledColor, shadowColor: ledColor }]} />
        <Text style={styles.title}>SWAT</Text>
        <Text style={styles.host} numberOfLines={1}>
          {st.host || `${cfg?.host || "?"}:${cfg?.port || ""}`}
        </Text>
        <Text style={[styles.nick, commander && { color: C.amber }]} numberOfLines={1}>
          {st.nick || cfg?.nick || "—"}{commander ? " ★" : ""}
        </Text>
        <TouchableOpacity
          onPress={() => (st.status === "down" ? connectSwat() : disconnectSwat())}
          style={styles.iconBtn}
        >
          <MaterialCommunityIcons
            name={st.status === "down" ? "lan-connect" : "lan-disconnect"}
            size={18}
            color={st.status === "down" ? C.green : C.red}
          />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setShowCfg((v) => !v)} style={styles.iconBtn}>
          <MaterialCommunityIcons name="cog" size={18} color={C.dim} />
        </TouchableOpacity>
      </View>

      {/* CONFIG PANEL */}
      {showCfg && cfg ? (
        <View style={styles.cfg}>
          <View style={styles.row}>
            <View style={{ flex: 2, marginRight: 8 }}>
              <Text style={styles.lbl}>HOST</Text>
              <TextInput style={styles.input} value={cfg.host} onChangeText={(t) => patch({ host: t })}
                autoCapitalize="none" autoCorrect={false} placeholderTextColor={C.dim} />
            </View>
            <View style={{ width: 78 }}>
              <Text style={styles.lbl}>PORT</Text>
              <TextInput style={styles.input} value={String(cfg.port)} keyboardType="numeric"
                onChangeText={(t) => patch({ port: parseInt(t || "0", 10) || 0 })} placeholderTextColor={C.dim} />
            </View>
          </View>
          <View style={styles.row}>
            <View style={{ flex: 1, marginRight: 8 }}>
              <Text style={styles.lbl}>NICK</Text>
              <TextInput style={styles.input} value={cfg.nick} onChangeText={(t) => patch({ nick: t })}
                autoCapitalize="none" autoCorrect={false} placeholderTextColor={C.dim} />
            </View>
            <View style={{ width: 110 }}>
              <Text style={styles.lbl}>CHANNEL</Text>
              <TextInput style={styles.input} value={cfg.channel} onChangeText={(t) => patch({ channel: t })}
                autoCapitalize="none" autoCorrect={false} placeholderTextColor={C.dim} />
            </View>
          </View>
          <View style={[styles.row, { alignItems: "center", marginTop: 8 }]}>
            <Switch value={cfg.autoconnect} onValueChange={(v) => patch({ autoconnect: v })}
              trackColor={{ false: C.border, true: "#1a3a2a" }} thumbColor={cfg.autoconnect ? C.green : C.dim} />
            <Text style={styles.lbl}>  autoconnect on open</Text>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={saveCfg} style={styles.saveBtn}>
              <Text style={styles.saveTxt}>SAVE &amp; RECONNECT</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {/* ROSTER STRIP */}
      <View style={styles.rosterWrap}>
        <MaterialCommunityIcons name="account-group" size={13} color={C.dim} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginLeft: 6 }}>
          {st.roster.length === 0 ? (
            <Text style={styles.rosterEmpty}>no members</Text>
          ) : (
            st.roster.map((n) => (
              <View key={n} style={[styles.chip, isCommander(n) && { borderColor: C.amber }]}>
                <Text style={[styles.chipTxt, isCommander(n) && { color: C.amber }]}>{n}</Text>
              </View>
            ))
          )}
        </ScrollView>
      </View>

      {/* EVENT FEED */}
      <ScrollView
        ref={feedRef}
        style={styles.feed}
        contentContainerStyle={{ padding: 8 }}
        onScrollBeginDrag={() => setAutoScroll(false)}
      >
        {st.events.length === 0 ? (
          <Text style={styles.feedEmpty}>// waiting for #SWAT traffic…</Text>
        ) : (
          st.events.map((e) => {
            const segs = parseIrcColored(e.text);
            const fallback = COL[e.color];
            return (
              <View key={e.id} style={styles.line}>
                <Text style={styles.lineTs}>{ts(e.ts)}</Text>
                <Text style={[styles.lineFrom, e.system && { color: C.dim, fontStyle: "italic" }]} numberOfLines={1}>
                  {e.system ? "*" : e.from}
                </Text>
                <Text style={styles.lineTxt}>
                  {segs.map((sg, i) => (
                    <Text key={i} style={{ color: sg.color ?? fallback }}>{sg.t}</Text>
                  ))}
                </Text>
              </View>
            );
          })
        )}
      </ScrollView>

      {/* BOTTOM BAR */}
      <View style={styles.bottom}>
        {!autoScroll ? (
          <TouchableOpacity onPress={() => setAutoScroll(true)} style={styles.jump}>
            <MaterialCommunityIcons name="arrow-down" size={14} color={C.surface} />
          </TouchableOpacity>
        ) : null}
        <TextInput
          style={styles.send}
          value={draft}
          onChangeText={setDraft}
          placeholder={commander ? "verb line (STATUS · TASK @agent … · MISSION …)" : "STATUS · LEASES · HELP · TASK @agent …"}
          placeholderTextColor={C.dim}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={send}
          returnKeyType="send"
          editable={st.status === "connected"}
        />
        <TouchableOpacity onPress={send} style={[styles.sendBtn, st.status !== "connected" && { opacity: 0.4 }]} disabled={st.status !== "connected"}>
          <MaterialCommunityIcons name="send" size={16} color={C.surface} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.surface },
  topStrip: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.panel,
  },
  led: { width: 10, height: 10, borderRadius: 5, shadowOpacity: 0.9, shadowRadius: 4, elevation: 2 },
  title: { color: C.text, fontFamily: MONO, fontSize: 14, fontWeight: "800", letterSpacing: 2, marginLeft: 8 },
  host: { color: C.cyan, fontFamily: MONO, fontSize: 10, marginLeft: 10, flex: 1 },
  nick: { color: C.text, fontFamily: MONO, fontSize: 11, marginRight: 4, maxWidth: 130 },
  iconBtn: { padding: 6, marginLeft: 2 },
  cfg: { backgroundColor: C.panel2, borderBottomWidth: 1, borderBottomColor: C.border, padding: 10 },
  row: { flexDirection: "row", marginTop: 6 },
  lbl: { color: C.dim, fontFamily: MONO, fontSize: 9, letterSpacing: 1, marginBottom: 3 },
  input: {
    backgroundColor: "#02050a", borderWidth: 1, borderColor: C.border, borderRadius: 4,
    color: C.text, fontFamily: MONO, fontSize: 12, paddingHorizontal: 8, paddingVertical: 6,
  },
  saveBtn: { backgroundColor: C.green, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 8 },
  saveTxt: { color: C.surface, fontFamily: MONO, fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  rosterWrap: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 6,
    borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.panel,
  },
  rosterEmpty: { color: C.dim, fontFamily: MONO, fontSize: 10 },
  chip: {
    borderWidth: 1, borderColor: C.border, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3,
    marginRight: 5, backgroundColor: C.panel2,
  },
  chipTxt: { color: C.text, fontFamily: MONO, fontSize: 10 },
  feed: { flex: 1, backgroundColor: C.surface },
  feedEmpty: { color: C.dim, fontFamily: MONO, fontSize: 11, textAlign: "center", marginTop: 24 },
  line: { flexDirection: "row", marginBottom: 3, flexWrap: "wrap" },
  lineTs: { color: "#3a5560", fontFamily: MONO, fontSize: 9, marginRight: 6, marginTop: 1 },
  lineFrom: { color: C.cyan, fontFamily: MONO, fontSize: 10, marginRight: 6, maxWidth: 96 },
  lineTxt: { fontFamily: MONO, fontSize: 11, flex: 1, minWidth: 160 },
  bottom: {
    flexDirection: "row", alignItems: "center", padding: 8, borderTopWidth: 1,
    borderTopColor: C.border, backgroundColor: C.panel,
  },
  jump: { backgroundColor: C.amber, borderRadius: 4, padding: 6, marginRight: 6 },
  send: {
    flex: 1, backgroundColor: "#02050a", borderWidth: 1, borderColor: C.border, borderRadius: 6,
    color: C.text, fontFamily: MONO, fontSize: 12, paddingHorizontal: 10, paddingVertical: 8,
  },
  sendBtn: { backgroundColor: C.green, borderRadius: 6, padding: 10, marginLeft: 6 },
});
