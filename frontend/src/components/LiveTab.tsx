import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Alert, Platform,
} from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { sessionManager, SessionState } from "../lib/sessionManager";
import { hasNativeStreaming, RootShell, HAS_NATIVE_ROOT } from "../lib/rootShell";

const C = {
  bg: "#04070a", panel: "#0a1116", panel2: "#0e1820", border: "#163041",
  green: "#00ff66", greenDim: "#0a8a3a", cyan: "#3ad7ff", red: "#ff3860",
  yellow: "#ffd400", magenta: "#ff5cdb", text: "#cfeadb", textDim: "#6c8a82",
};
const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

type Props = {
  iface: string;
  ifaceB: string;
  ifaceC: string;
  primaryIface: string;
  country: string;
  execMode: "mock" | "real" | "kali";
  wrap: (cmd: string) => string;   // wraps a command for current exec mode (kali chroot etc.)
};

// One-tap streaming presets — substitute $IFACE at use time
const PRESETS: { label: string; icon: any; cmd: (iface: string) => string; desc: string }[] = [
  {
    label: "airodump-ng",
    icon: "wifi-strength-4-alert",
    cmd: (i) => `airodump-ng ${i}`,
    desc: "live AP/STA scan",
  },
  {
    label: "airodump → CSV",
    icon: "file-table",
    cmd: (i) => `airodump-ng -w /sdcard/cap_${Date.now()} --output-format csv,pcap ${i}`,
    desc: "capture to /sdcard/cap_<ts>",
  },
  {
    label: "wifite PMKID",
    icon: "key-variant",
    cmd: (i) => `wifite --pmkid --no-deauths --kill -i ${i}`,
    desc: "PMKID hash grab (no clients harmed)",
  },
  {
    label: "wifite WPA",
    icon: "shield-key",
    cmd: (i) => `wifite --wpa --kill -i ${i}`,
    desc: "WPA handshake + crack",
  },
  {
    label: "hcxdumptool",
    icon: "database-export",
    cmd: (i) => `hcxdumptool -i ${i} -o /sdcard/hcx_${Date.now()}.pcapng --enable_status=1`,
    desc: "PMKID/EAPOL capture (modern)",
  },
  {
    label: "tcpdump",
    icon: "network",
    cmd: (i) => `tcpdump -i ${i} -w /sdcard/tcpdump_${Date.now()}.pcap -U`,
    desc: "full packet capture",
  },
  {
    label: "iw event",
    icon: "console-network",
    cmd: () => "iw event -t",
    desc: "kernel wireless events",
  },
  {
    label: "dmesg -w",
    icon: "console-line",
    cmd: () => "dmesg -w",
    desc: "live kernel log",
  },
];

export default function LiveTab(props: Props) {
  const [, force] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [customCmd, setCustomCmd] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [presetOpen, setPresetOpen] = useState(false);
  const outRef = useRef<ScrollView>(null);

  useEffect(() => sessionManager.subscribe(() => force((n) => n + 1)), []);
  const sessions = sessionManager.list();

  // Auto-select newest running session if nothing selected
  useEffect(() => {
    if (!selectedId && sessions.length > 0) setSelectedId(sessions[0].id);
    if (selectedId && !sessions.find((s) => s.id === selectedId) && sessions.length > 0) {
      setSelectedId(sessions[0].id);
    }
  }, [sessions, selectedId]);

  const selected: SessionState | undefined = useMemo(
    () => sessions.find((s) => s.id === selectedId),
    [sessions, selectedId],
  );

  useEffect(() => {
    if (!autoScroll || !selected) return;
    const t = setTimeout(() => outRef.current?.scrollToEnd({ animated: false }), 30);
    return () => clearTimeout(t);
  }, [selected?.lines.length, selected?.status, autoScroll]);

  const startSession = useCallback(async (cmd: string, ifaceHint?: string) => {
    if (!cmd.trim()) return;
    const ifaceForCmd = ifaceHint || props.primaryIface;
    const wrapped = props.wrap(cmd);
    const id = await sessionManager.start({
      command: wrapped,
      iface: ifaceForCmd,
      label: cmd.split(/\s+/)[0],
      forceMock: props.execMode === "mock",
    });
    setSelectedId(id);
    setCustomCmd("");
    setPresetOpen(false);
  }, [props.primaryIface, props.wrap, props.execMode]);

  const runPreset = (p: typeof PRESETS[number]) => {
    const cmd = p.cmd(props.primaryIface);
    startSession(cmd, props.primaryIface);
  };

  const onStop = (s: SessionState) => sessionManager.kill(s.id, true);
  const onForceKill = (s: SessionState) =>
    Alert.alert("Force kill?", `SIGKILL ${s.label} (PID ${s.pid || "?"})\nFiles may not be flushed.`, [
      { text: "Cancel" },
      { text: "SIGKILL", style: "destructive", onPress: () => sessionManager.kill(s.id, false) },
    ]);
  const onRemove = (s: SessionState) => sessionManager.remove(s.id);

  const statusColor = (st: SessionState["status"]) =>
    st === "running" ? C.green :
    st === "starting" ? C.yellow :
    st === "ended" ? C.greenDim :
    st === "killed" ? C.magenta :
    C.red;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {/* Persistent bridge diagnostic — debugging "stuck in mock" symptoms */}
      <View style={s.bridgeBar}>
        {(() => {
          const hasMod = !!RootShell;
          const keys = hasMod ? Object.keys(RootShell as any) : [];
          const exec = hasMod ? typeof (RootShell as any).executeStream : "no-mod";
          const kill = hasMod ? typeof (RootShell as any).killSession : "no-mod";
          const ok = hasNativeStreaming();
          const modeOk = props.execMode !== "mock";
          return (
            <Text style={[s.bridgeText, { color: ok && modeOk ? C.greenDim : C.yellow }]}>
              <Text style={{ color: C.textDim }}>bridge </Text>
              root=<Text style={{ color: HAS_NATIVE_ROOT ? C.green : C.red }}>{HAS_NATIVE_ROOT ? "✓" : "✗"}</Text>{" · "}
              stream=<Text style={{ color: ok ? C.green : C.red }}>{ok ? "✓" : "✗"}</Text>{" · "}
              mode=<Text style={{ color: modeOk ? C.green : C.yellow }}>{props.execMode}</Text>{" · "}
              keys={keys.length} · exec={String(exec)} · kill={String(kill)}
            </Text>
          );
        })()}
      </View>

      {/* Session chips */}
      <View style={s.chipBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 8 }}>
          {sessions.length === 0 && (
            <Text style={[s.helper, { marginLeft: 8, alignSelf: "center" }]}>
              no live sessions — tap presets below to start
            </Text>
          )}
          {sessions.map((sess) => {
            const active = sess.id === selectedId;
            return (
              <TouchableOpacity
                key={sess.id}
                testID={`live-chip-${sess.id}`}
                onPress={() => setSelectedId(sess.id)}
                style={[s.sessChip, active && { borderColor: C.green, backgroundColor: "#0a1f12" }]}
              >
                <View style={[s.dot, { backgroundColor: statusColor(sess.status) }]} />
                <Text style={[s.sessChipLabel, active && { color: C.green }]} numberOfLines={1}>
                  {sess.label}
                </Text>
                <Text style={s.sessChipMeta}>{sess.iface ? sess.iface : ""} · {sess.lineCount}L</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        <TouchableOpacity
          testID="btn-presets"
          onPress={() => setPresetOpen((v) => !v)}
          style={s.newBtn}
        >
          <Ionicons name={presetOpen ? "close" : "add"} size={16} color={C.bg} />
        </TouchableOpacity>
      </View>

      {/* Presets drawer */}
      {presetOpen && (
        <View style={s.presetDrawer}>
          <Text style={s.presetTitle}>// stream presets · iface={props.primaryIface}</Text>
          <View style={s.presetGrid}>
            {PRESETS.map((p, i) => (
              <TouchableOpacity
                key={i}
                testID={`live-preset-${i}`}
                onPress={() => runPreset(p)}
                style={s.presetItem}
              >
                <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 2 }}>
                  <MaterialCommunityIcons name={p.icon} size={14} color={C.green} />
                  <Text style={[s.presetLabel, { marginLeft: 4 }]}>{p.label}</Text>
                </View>
                <Text style={s.presetDesc} numberOfLines={1}>{p.desc}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={[s.cmdRow, { marginTop: 6 }]}>
            <Text style={{ color: C.greenDim, fontFamily: MONO, fontSize: 13 }}># </Text>
            <TextInput
              testID="input-live-custom"
              value={customCmd} onChangeText={setCustomCmd}
              placeholder="custom command…" placeholderTextColor={C.textDim}
              style={s.cmdInput} autoCapitalize="none" autoCorrect={false}
              onSubmitEditing={() => startSession(customCmd)}
              returnKeyType="send"
            />
            <TouchableOpacity
              testID="btn-live-run"
              onPress={() => startSession(customCmd)}
              style={[s.runBtn, !customCmd.trim() && { opacity: 0.4 }]}
              disabled={!customCmd.trim()}
            >
              <Ionicons name="play" size={14} color={C.bg} />
              <Text style={s.runBtnText}>RUN</Text>
            </TouchableOpacity>
          </View>
          {!hasNativeStreaming() && (
            <Text style={[s.helper, { color: C.yellow, marginTop: 6 }]}>
              ⚠ native streaming unavailable — presets run in MOCK simulator. Build the APK for real exec.
            </Text>
          )}
        </View>
      )}

      {/* Output area */}
      {selected ? (
        <View style={{ flex: 1 }}>
          {/* Header meta */}
          <View style={s.sessHeader}>
            <View style={{ flex: 1 }}>
              <Text style={s.sessTitle} numberOfLines={1}>{selected.command}</Text>
              <Text style={s.sessMeta}>
                <Text style={{ color: statusColor(selected.status) }}>{selected.status.toUpperCase()}</Text>
                {selected.pid ? <Text style={{ color: C.textDim }}> · pid={selected.pid}</Text> : null}
                <Text style={{ color: C.textDim }}> · {selected.lineCount} lines</Text>
                {selected.exitCode !== undefined ? (
                  <Text style={{ color: selected.exitCode === 0 ? C.greenDim : C.red }}>
                    {" · exit="}{selected.exitCode}
                  </Text>
                ) : null}
              </Text>
            </View>
            <View style={{ flexDirection: "row" }}>
              <TouchableOpacity
                testID="btn-auto-scroll"
                onPress={() => setAutoScroll((v) => !v)}
                style={[s.headBtn, { borderColor: autoScroll ? C.green : C.border }]}
              >
                <MaterialCommunityIcons name={autoScroll ? "arrow-down-thin-circle-outline" : "pause"} size={14} color={autoScroll ? C.green : C.textDim} />
              </TouchableOpacity>
              {(selected.status === "running" || selected.status === "starting") && (
                <>
                  <TouchableOpacity
                    testID={`btn-stop-${selected.id}`}
                    onPress={() => onStop(selected)}
                    style={[s.headBtn, { borderColor: C.yellow }]}
                  >
                    <Ionicons name="stop" size={14} color={C.yellow} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    testID={`btn-kill-${selected.id}`}
                    onPress={() => onForceKill(selected)}
                    style={[s.headBtn, { borderColor: C.red }]}
                  >
                    <MaterialCommunityIcons name="skull" size={14} color={C.red} />
                  </TouchableOpacity>
                </>
              )}
              <TouchableOpacity
                testID={`btn-remove-${selected.id}`}
                onPress={() => onRemove(selected)}
                style={[s.headBtn, { borderColor: C.border }]}
              >
                <Ionicons name="trash" size={14} color={C.textDim} />
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView
            ref={outRef}
            style={{ flex: 1, backgroundColor: "#02050a" }}
            contentContainerStyle={{ padding: 10, paddingBottom: 24 }}
            onScrollBeginDrag={() => setAutoScroll(false)}
          >
            {selected.lines.length === 0 ? (
              <Text style={s.helper}>(no output yet)</Text>
            ) : (
              selected.lines.map((l, i) => (
                <Text
                  key={`${l.line_no}-${i}`}
                  selectable
                  style={[s.outLine, l.stream === "stderr" && { color: C.red }]}
                >
                  {l.line}
                </Text>
              ))
            )}
            {selected.errorMessage && (
              <Text style={[s.outLine, { color: C.red, marginTop: 6 }]}>
                [error] {selected.errorMessage}
              </Text>
            )}
          </ScrollView>
        </View>
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <MaterialCommunityIcons name="satellite-uplink" size={48} color={C.greenDim} />
          <Text style={[s.helper, { marginTop: 12, textAlign: "center" }]}>
            no active session — tap{" "}
            <Text style={{ color: C.green }}>+</Text> to launch a streaming preset
          </Text>
          <Text style={[s.helper, { marginTop: 4, textAlign: "center", color: C.textDim }]}>
            airodump · wifite · tcpdump · hcxdumptool · ...
          </Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  bridgeBar: {
    backgroundColor: "#020608", borderBottomWidth: 1, borderBottomColor: C.border,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  bridgeText: { fontFamily: MONO, fontSize: 9 },
  chipBar: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: C.panel, borderBottomWidth: 1, borderBottomColor: C.border,
    minHeight: 50,
  },
  sessChip: {
    paddingHorizontal: 10, paddingVertical: 6,
    borderWidth: 1, borderColor: C.border, borderRadius: 4,
    marginRight: 6, flexDirection: "row", alignItems: "center", maxWidth: 200,
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  sessChipLabel: { color: C.text, fontFamily: MONO, fontSize: 11, fontWeight: "700" },
  sessChipMeta: { color: C.textDim, fontFamily: MONO, fontSize: 9, marginLeft: 6 },
  newBtn: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: C.green,
    alignItems: "center", justifyContent: "center", marginRight: 10,
  },

  presetDrawer: {
    backgroundColor: C.panel, borderBottomWidth: 1, borderBottomColor: C.border, padding: 10,
  },
  presetTitle: { color: C.greenDim, fontFamily: MONO, fontSize: 10, marginBottom: 6 },
  presetGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  presetItem: {
    width: "48.5%", backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border,
    borderRadius: 4, padding: 8, marginBottom: 6,
  },
  presetLabel: { color: C.text, fontFamily: MONO, fontSize: 11, fontWeight: "700" },
  presetDesc: { color: C.textDim, fontFamily: MONO, fontSize: 9 },

  cmdRow: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: 4,
    paddingHorizontal: 8,
  },
  cmdInput: { flex: 1, color: C.green, fontFamily: MONO, fontSize: 12, paddingVertical: 8, marginLeft: 4 },
  runBtn: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: C.green, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 3,
  },
  runBtnText: { color: C.bg, fontFamily: MONO, fontSize: 10, fontWeight: "800", marginLeft: 3 },

  sessHeader: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: C.panel, borderBottomWidth: 1, borderBottomColor: C.border,
    paddingHorizontal: 10, paddingVertical: 8,
  },
  sessTitle: { color: C.green, fontFamily: MONO, fontSize: 11, fontWeight: "700" },
  sessMeta: { fontFamily: MONO, fontSize: 9, marginTop: 2 },
  headBtn: {
    width: 30, height: 30, borderRadius: 4, marginLeft: 4,
    borderWidth: 1, alignItems: "center", justifyContent: "center",
  },

  outLine: { color: C.text, fontFamily: MONO, fontSize: 10, lineHeight: 13 },
  helper: { color: C.textDim, fontFamily: MONO, fontSize: 10 },
});
