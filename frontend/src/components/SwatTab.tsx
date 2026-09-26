/* eslint-disable react/jsx-no-comment-textnodes */
/**
 * SwatTab — the SWAT IRC control-plane cockpit (Phase A + basic send).
 * Connection LED + host/nick strip · roster chips · verb-coloured live feed ·
 * bottom send box. Config lives in an inline gear panel (host/port/nick/chan).
 */
import React, { useEffect, useRef, useState, useSyncExternalStore, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Platform, AppState,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import {
  subscribeSwat, getSwatState, connectSwat, disconnectSwat, swatSend,
  loadSwatConfig, isCommander, parseIrcColored,
  clearOpsEcho,
  type SwatConfig, type EventColor,
} from "../lib/swatIrc";
import { SWAT_OPS, isSwatOp } from "../lib/swatOps";

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
  const [autoScroll, setAutoScroll] = useState(true);
  const [draft, setDraft] = useState("");
  const [missionOpen, setMissionOpen] = useState(false);
  const [steps, setSteps] = useState<{ agent: string; cmd: string }[]>([{ agent: "", cmd: "" }]);
  const [missionSeq, setMissionSeq] = useState(1);
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

  // On resume, if we intended to be connected but dropped while backgrounded,
  // kick a reconnect immediately (don't wait for the backoff timer).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        if (cfg?.autoconnect && getSwatState().status === "down") connectSwat();
      }
    });
    return () => sub.remove();
  }, [cfg?.autoconnect]);

  const ledColor = st.status === "connected" ? C.green : st.status === "connecting" ? C.amber : C.red;
  const commander = isCommander(st.nick || cfg?.nick || "");

  const send = useCallback(() => {
    const t = draft.trim();
    if (!t) return;
    swatSend(t);
    setDraft("");
  }, [draft]);

  const connected = st.status === "connected";
  // Quick-verb helpers. STATUS/LEASES/HELP fire immediately (no payload);
  // TASK/ABORT prefill the input so the operator adds target/payload.
  const fire = useCallback((v: string) => { if (connected) swatSend(v); }, [connected]);
  const prefill = useCallback((v: string) => setDraft(v), []);

  const buildMission = useCallback(() => {
    const parts = steps
      .filter((s) => s.agent.trim() && s.cmd.trim())
      .map((s) => `@${s.agent.trim().replace(/^@/, "")} ${s.cmd.trim()}`);
    if (!parts.length) return;
    swatSend(`MISSION #m${missionSeq} ${parts.join(" | ")}`);
    setMissionSeq((n) => n + 1);
    setSteps([{ agent: "", cmd: "" }]);
    setMissionOpen(false);
  }, [steps, missionSeq]);

  const CHIP = ({ label, color, onPress }: { label: string; color: string; onPress: () => void }) => (
    <TouchableOpacity
      onPress={onPress}
      disabled={!connected}
      style={[styles.vchip, { borderColor: color }, !connected && { opacity: 0.4 }]}
    >
      <Text style={[styles.vchipTxt, { color }]}>{label}</Text>
    </TouchableOpacity>
  );

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
      </View>

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

      {/* OPS ECHO DRIFT PANEL — conductor's echoed swat_ops vs app's shipped list */}
      {st.opsEcho ? (
        <View style={styles.opsPanel}>
          <View style={styles.opsHeader}>
            <MaterialCommunityIcons name="shield-star" size={13} color={C.amber} />
            <Text style={styles.opsTitle}>OPS ECHO · conductor</Text>
            <Text style={styles.opsTs}>{ts(st.opsEcho.at)}</Text>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={clearOpsEcho} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <MaterialCommunityIcons name="close" size={16} color={C.dim} />
            </TouchableOpacity>
          </View>
          <View style={styles.opsChips}>
            {st.opsEcho.nicks.map((n) => {
              const known = isSwatOp(n); // in the app's shipped list too
              const col = known ? C.green : C.amber;
              return (
                <View key={`c-${n}`} style={[styles.opsChip, { borderColor: col }]}>
                  <Text style={[styles.opsChipTxt, { color: col }]}>{n}</Text>
                  {!known ? <Text style={styles.opsChipTxt}> ⚠</Text> : null}
                </View>
              );
            })}
          </View>
          {(() => {
            const echoLc = st.opsEcho!.nicks.map((n) => n.toLowerCase());
            const missing = SWAT_OPS.filter((o) => !echoLc.includes(o.toLowerCase()));
            const extra = st.opsEcho!.nicks.filter((n) => !isSwatOp(n));
            if (!missing.length && !extra.length) {
              return <Text style={styles.opsOk}>✓ in sync with shipped list</Text>;
            }
            return (
              <View style={{ marginTop: 4 }}>
                {extra.length ? (
                  <Text style={styles.opsDrift}>⚠ conductor-only (app missing): {extra.join(", ")}</Text>
                ) : null}
                {missing.length ? (
                  <Text style={styles.opsDrift}>⚠ app-only (conductor missing): {missing.join(", ")}</Text>
                ) : null}
              </View>
            );
          })()}
        </View>
      ) : null}

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

      {/* MISSION COMPOSER (commander only) */}
      {missionOpen && commander ? (
        <View style={styles.composer}>
          <View style={styles.row}>
            <Text style={[styles.title, { fontSize: 12 }]}>MISSION #m{missionSeq}</Text>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={() => setMissionOpen(false)}>
              <MaterialCommunityIcons name="close" size={18} color={C.dim} />
            </TouchableOpacity>
          </View>
          {steps.map((s, i) => (
            <View key={i} style={[styles.row, { marginTop: 6 }]}>
              <TextInput
                style={[styles.input, { width: 96, marginRight: 6 }]}
                value={s.agent}
                onChangeText={(t) => setSteps((arr) => arr.map((x, j) => (j === i ? { ...x, agent: t } : x)))}
                placeholder="@agent" placeholderTextColor={C.dim} autoCapitalize="none" autoCorrect={false}
              />
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={s.cmd}
                onChangeText={(t) => setSteps((arr) => arr.map((x, j) => (j === i ? { ...x, cmd: t } : x)))}
                placeholder="command" placeholderTextColor={C.dim} autoCapitalize="none" autoCorrect={false}
              />
              {steps.length > 1 ? (
                <TouchableOpacity onPress={() => setSteps((arr) => arr.filter((_, j) => j !== i))} style={{ padding: 6 }}>
                  <MaterialCommunityIcons name="minus-circle-outline" size={18} color={C.red} />
                </TouchableOpacity>
              ) : null}
            </View>
          ))}
          <View style={[styles.row, { marginTop: 8, alignItems: "center" }]}>
            <TouchableOpacity onPress={() => setSteps((arr) => [...arr, { agent: "", cmd: "" }])} style={styles.stepAdd}>
              <MaterialCommunityIcons name="plus" size={14} color={C.cyan} />
              <Text style={[styles.vchipTxt, { color: C.cyan }]}> STEP</Text>
            </TouchableOpacity>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={buildMission} style={styles.launchBtn}>
              <MaterialCommunityIcons name="rocket-launch" size={14} color={C.surface} />
              <Text style={styles.launchTxt}> LAUNCH</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {/* QUICK VERB CHIPS */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsRow} contentContainerStyle={{ alignItems: "center", paddingHorizontal: 8 }}>
        <CHIP label="STATUS" color={C.grey} onPress={() => fire("STATUS")} />
        <CHIP label="LEASES" color={C.grey} onPress={() => fire("LEASES")} />
        <CHIP label="OPS" color={C.grey} onPress={() => fire("OPS")} />
        <CHIP label="HELP" color={C.grey} onPress={() => fire("HELP")} />
        <CHIP label="TASK @all" color={C.amber} onPress={() => prefill("TASK @all ")} />
        <CHIP label="STOP #" color={C.amber} onPress={() => prefill("STOP #")} />
        {commander ? (
          <>
            <View style={styles.chipDiv} />
            <CHIP label="★ MISSION" color={C.amber} onPress={() => setMissionOpen((v) => !v)} />
            <CHIP label="ABORT #" color={C.red} onPress={() => prefill("ABORT #")} />
            <CHIP label="HALT" color={C.red} onPress={() => fire("HALT")} />
            <CHIP label="RESUME" color={C.green} onPress={() => fire("RESUME")} />
          </>
        ) : null}
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
  keepAlive: {
    marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.border,
  },
  keepAliveHint: { color: C.dim, fontFamily: MONO, fontSize: 9, marginTop: 6, lineHeight: 13 },
  permRow: { flexDirection: "row", alignItems: "center", marginTop: 8 },
  permLabel: { color: C.text, fontFamily: MONO, fontSize: 11, marginLeft: 8, flex: 1 },
  permState: { fontFamily: MONO, fontSize: 9, marginRight: 8, letterSpacing: 0.5 },
  permBtn: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 6, minWidth: 74, alignItems: "center" },
  permBtnTxt: { fontFamily: MONO, fontSize: 10, fontWeight: "800", letterSpacing: 1 },
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
  opsPanel: {
    backgroundColor: C.panel2, borderBottomWidth: 1, borderBottomColor: C.border,
    paddingHorizontal: 10, paddingVertical: 8,
  },
  opsHeader: { flexDirection: "row", alignItems: "center" },
  opsTitle: { color: C.amber, fontFamily: MONO, fontSize: 10, fontWeight: "800", letterSpacing: 1, marginLeft: 6 },
  opsTs: { color: "#3a5560", fontFamily: MONO, fontSize: 9, marginLeft: 8 },
  opsChips: { flexDirection: "row", flexWrap: "wrap", marginTop: 6 },
  opsChip: {
    flexDirection: "row", alignItems: "center", borderWidth: 1, borderRadius: 4,
    paddingHorizontal: 8, paddingVertical: 3, marginRight: 5, marginBottom: 5, backgroundColor: C.panel,
  },
  opsChipTxt: { color: C.amber, fontFamily: MONO, fontSize: 10 },
  opsOk: { color: C.green, fontFamily: MONO, fontSize: 9, marginTop: 4 },
  opsDrift: { color: C.amber, fontFamily: MONO, fontSize: 9, marginBottom: 2 },
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
  chipsRow: {
    maxHeight: 40, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.panel2,
  },
  vchip: {
    borderWidth: 1, borderRadius: 4, paddingHorizontal: 9, paddingVertical: 5,
    marginRight: 6, backgroundColor: C.panel,
  },
  vchipTxt: { fontFamily: MONO, fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  chipDiv: { width: 1, height: 20, backgroundColor: C.border, marginHorizontal: 6 },
  composer: {
    backgroundColor: C.panel2, borderTopWidth: 1, borderTopColor: C.border, padding: 10,
  },
  stepAdd: {
    flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: C.cyan,
    borderRadius: 4, paddingHorizontal: 8, paddingVertical: 5,
  },
  launchBtn: {
    flexDirection: "row", alignItems: "center", backgroundColor: C.amber,
    borderRadius: 4, paddingHorizontal: 12, paddingVertical: 7,
  },
  launchTxt: { color: C.surface, fontFamily: MONO, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  jump: { backgroundColor: C.amber, borderRadius: 4, padding: 6, marginRight: 6 },
  send: {
    flex: 1, backgroundColor: "#02050a", borderWidth: 1, borderColor: C.border, borderRadius: 6,
    color: C.text, fontFamily: MONO, fontSize: 12, paddingHorizontal: 10, paddingVertical: 8,
  },
  sendBtn: { backgroundColor: C.green, borderRadius: 6, padding: 10, marginLeft: 6 },
});
