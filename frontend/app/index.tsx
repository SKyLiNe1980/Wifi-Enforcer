import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Modal,
  Alert,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";

const API = `${process.env.EXPO_PUBLIC_BACKEND_URL}/api`;

// Kali-ish palette
const C = {
  bg: "#04070a",
  panel: "#0a1116",
  panel2: "#0e1820",
  border: "#163041",
  green: "#00ff66",
  greenDim: "#0a8a3a",
  cyan: "#3ad7ff",
  red: "#ff3860",
  yellow: "#ffd400",
  text: "#cfeadb",
  textDim: "#6c8a82",
  prompt: "#5cffb1",
};

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

type Log = {
  id: string;
  command: string;
  output: string;
  exit_code: number;
  duration_ms: number;
  mocked: boolean;
  timestamp: string;
};

type Profile = {
  id: string;
  name: string;
  description: string;
  commands: string[];
  created_at: string;
};

const QUICK_COMMANDS: { label: string; cmd: (ctx: Ctx) => string; icon: any }[] = [
  { label: "Disable WiFi", cmd: () => "svc wifi disable", icon: "wifi-off" },
  { label: "Enable WiFi", cmd: () => "svc wifi enable", icon: "wifi" },
  { label: "Iface DOWN", cmd: (c) => `ifconfig ${c.iface} down`, icon: "arrow-down-bold" },
  { label: "Iface UP", cmd: (c) => `ifconfig ${c.iface} up`, icon: "arrow-up-bold" },
  { label: "Set Iface prop", cmd: (c) => `setprop wifi.interface ${c.iface}`, icon: "code-tags" },
  { label: "iw reg set", cmd: (c) => `iw reg set ${c.country}`, icon: "earth" },
  { label: "wifi.country", cmd: (c) => `setprop wifi.country ${c.country}`, icon: "flag" },
  { label: "Force CC", cmd: (c) => `cmd wifi force-country-code enabled ${c.country}`, icon: "shield-check" },
  { label: "Reset CC", cmd: () => "cmd wifi force-country-code disabled", icon: "shield-off" },
  { label: "iw reg get", cmd: () => "iw reg get", icon: "magnify" },
  { label: "iwconfig", cmd: () => "iwconfig", icon: "console-line" },
  { label: "wifi status", cmd: () => "cmd wifi status", icon: "information" },
];

type Ctx = { iface: string; country: string };

export default function Index() {
  const [iface, setIface] = useState("wlan2");
  const [country, setCountry] = useState("US");
  const [logs, setLogs] = useState<Log[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [customCmd, setCustomCmd] = useState("");
  const [running, setRunning] = useState(false);
  const [rootInfo, setRootInfo] = useState<any>(null);
  const [profileModal, setProfileModal] = useState(false);
  const [saveModal, setSaveModal] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileDesc, setNewProfileDesc] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const termRef = useRef<ScrollView>(null);

  const ctx: Ctx = { iface, country };

  const fetchAll = useCallback(async () => {
    try {
      const [h, lg, pf] = await Promise.all([
        fetch(`${API}/health`).then((r) => r.json()),
        fetch(`${API}/logs?limit=200`).then((r) => r.json()),
        fetch(`${API}/profiles`).then((r) => r.json()),
      ]);
      setRootInfo(h);
      setLogs((lg as Log[]).slice().reverse());
      setProfiles(pf as Profile[]);
    } catch (e) {
      console.warn("fetchAll error", e);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    const t = setTimeout(() => termRef.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(t);
  }, [logs]);

  async function execute(command: string) {
    if (!command.trim() || running) return;
    setRunning(true);
    try {
      const res = await fetch(`${API}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
      const data: Log = await res.json();
      setLogs((prev) => [...prev, data]);
    } catch (e: any) {
      setLogs((prev) => [
        ...prev,
        {
          id: String(Date.now()),
          command,
          output: `[err] ${e?.message || e}`,
          exit_code: 1,
          duration_ms: 0,
          mocked: true,
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setRunning(false);
    }
  }

  async function runProfile(p: Profile) {
    setProfileModal(false);
    setRunning(true);
    try {
      const res = await fetch(`${API}/profiles/${p.id}/run`, { method: "POST" });
      const data = await res.json();
      setLogs((prev) => [...prev, ...(data.logs as Log[])]);
    } catch (e) {
      console.warn(e);
    } finally {
      setRunning(false);
    }
  }

  async function deleteProfile(id: string) {
    await fetch(`${API}/profiles/${id}`, { method: "DELETE" });
    fetchAll();
  }

  async function clearLogs() {
    await fetch(`${API}/logs`, { method: "DELETE" });
    setLogs([]);
  }

  async function saveProfile() {
    if (!newProfileName.trim()) {
      Alert.alert("Name required", "Give the profile a name");
      return;
    }
    const cmds = QUICK_COMMANDS.map((q) => q.cmd(ctx));
    await fetch(`${API}/profiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newProfileName.trim(),
        description: newProfileDesc.trim(),
        commands: cmds,
      }),
    });
    setSaveModal(false);
    setNewProfileName("");
    setNewProfileDesc("");
    fetchAll();
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <StatusBar style="light" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* HEADER */}
        <View style={styles.header} testID="app-header">
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <MaterialCommunityIcons name="shield-lock" size={22} color={C.green} />
            <Text style={styles.headerTitle}>wifi-enforcer</Text>
            <Text style={styles.headerVer}>v0.1</Text>
          </View>
          <View style={[styles.badge, { borderColor: C.yellow }]}>
            <Text style={[styles.badgeText, { color: C.yellow }]}>MOCK</Text>
          </View>
        </View>

        {/* STATUS BAR */}
        <View style={styles.statusBar}>
          <Text style={styles.statusItem}>
            <Text style={{ color: C.textDim }}>root: </Text>
            <Text style={{ color: rootInfo?.root_granted ? C.green : C.red }}>
              {rootInfo?.root_granted ? "GRANTED" : "..."}
            </Text>
          </Text>
          <Text style={styles.statusItem}>
            <Text style={{ color: C.textDim }}>dev: </Text>
            <Text style={{ color: C.cyan }}>{rootInfo?.device || "..."}</Text>
          </Text>
          <Text style={styles.statusItem}>
            <Text style={{ color: C.textDim }}>os: </Text>
            <Text style={{ color: C.cyan }}>{rootInfo?.android_version || "..."}</Text>
          </Text>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 32 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await fetchAll();
                setRefreshing(false);
              }}
              tintColor={C.green}
            />
          }
        >
          {/* CONTEXT (iface / country) */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>// context</Text>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={[styles.field, { flex: 1 }]}>
                <Text style={styles.fieldLabel}>$IFACE</Text>
                <TextInput
                  testID="input-iface"
                  value={iface}
                  onChangeText={setIface}
                  style={styles.fieldInput}
                  placeholder="wlan0"
                  placeholderTextColor={C.textDim}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              <View style={[styles.field, { width: 110 }]}>
                <Text style={styles.fieldLabel}>$CC</Text>
                <TextInput
                  testID="input-country"
                  value={country}
                  onChangeText={(t) => setCountry(t.toUpperCase().slice(0, 2))}
                  style={styles.fieldInput}
                  placeholder="US"
                  placeholderTextColor={C.textDim}
                  autoCapitalize="characters"
                  maxLength={2}
                />
              </View>
            </View>
          </View>

          {/* QUICK ACTIONS */}
          <View style={styles.section}>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionTitle}>// quick actions</Text>
              <TouchableOpacity
                testID="btn-save-profile"
                onPress={() => setSaveModal(true)}
                style={styles.smallBtn}
              >
                <Ionicons name="bookmark-outline" size={12} color={C.green} />
                <Text style={styles.smallBtnText}>save as profile</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.grid}>
              {QUICK_COMMANDS.map((q, i) => {
                const cmd = q.cmd(ctx);
                return (
                  <TouchableOpacity
                    key={i}
                    testID={`quick-${i}`}
                    style={styles.gridItem}
                    onPress={() => execute(cmd)}
                    disabled={running}
                    activeOpacity={0.7}
                  >
                    <MaterialCommunityIcons name={q.icon} size={16} color={C.green} />
                    <Text style={styles.gridLabel}>{q.label}</Text>
                    <Text style={styles.gridCmd} numberOfLines={1}>
                      {cmd}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* PROFILES */}
          <View style={styles.section}>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionTitle}>// profiles ({profiles.length})</Text>
              <TouchableOpacity
                testID="btn-open-profiles"
                onPress={() => setProfileModal(true)}
                style={styles.smallBtn}
              >
                <Ionicons name="list" size={12} color={C.green} />
                <Text style={styles.smallBtnText}>manage</Text>
              </TouchableOpacity>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingRight: 16 }}>
              {profiles.map((p) => (
                <TouchableOpacity
                  key={p.id}
                  testID={`profile-${p.id}`}
                  style={styles.profileCard}
                  onPress={() => runProfile(p)}
                  disabled={running}
                  activeOpacity={0.7}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <MaterialCommunityIcons name="play-circle" size={16} color={C.green} />
                    <Text style={styles.profileName} numberOfLines={1}>{p.name}</Text>
                  </View>
                  <Text style={styles.profileDesc} numberOfLines={2}>{p.description || "—"}</Text>
                  <Text style={styles.profileCount}>{p.commands.length} cmd{p.commands.length === 1 ? "" : "s"}</Text>
                </TouchableOpacity>
              ))}
              {profiles.length === 0 && (
                <Text style={{ color: C.textDim, fontFamily: MONO, padding: 12 }}>no profiles</Text>
              )}
            </ScrollView>
          </View>

          {/* TERMINAL */}
          <View style={[styles.section, { paddingBottom: 0 }]}>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionTitle}>// terminal</Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {running && <ActivityIndicator size="small" color={C.green} />}
                <TouchableOpacity testID="btn-clear-logs" onPress={clearLogs} style={styles.smallBtn}>
                  <Ionicons name="trash-outline" size={12} color={C.red} />
                  <Text style={[styles.smallBtnText, { color: C.red }]}>clear</Text>
                </TouchableOpacity>
              </View>
            </View>
            <View style={styles.terminal}>
              <ScrollView
                ref={termRef}
                style={{ maxHeight: 320 }}
                contentContainerStyle={{ padding: 10 }}
                nestedScrollEnabled
              >
                <Text style={styles.termIntro}>
                  {`# wifi-enforcer shell — su context [MOCKED]\n# device: ${rootInfo?.device || "..."}  os: ${rootInfo?.android_version || "..."}\n# ${logs.length} entries\n`}
                </Text>
                {logs.map((l) => (
                  <View key={l.id} style={{ marginBottom: 8 }}>
                    <Text style={styles.termPromptLine}>
                      <Text style={{ color: C.prompt }}>root@android</Text>
                      <Text style={{ color: C.textDim }}>:/ # </Text>
                      <Text style={{ color: C.text }}>{l.command}</Text>
                    </Text>
                    {!!l.output && (
                      <Text style={[styles.termOut, l.exit_code !== 0 && { color: C.red }]}>{l.output}</Text>
                    )}
                    <Text style={styles.termMeta}>
                      exit={l.exit_code} • {l.duration_ms}ms • {l.mocked ? "mock" : "real"}
                    </Text>
                  </View>
                ))}
                {logs.length === 0 && (
                  <Text style={{ color: C.textDim, fontFamily: MONO }}>
                    {`(no commands yet — tap a quick action or type below)`}
                  </Text>
                )}
              </ScrollView>
            </View>
          </View>

          {/* CUSTOM COMMAND */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>// custom</Text>
            <View style={styles.cmdRow}>
              <Text style={{ color: C.prompt, fontFamily: MONO, fontSize: 13 }}># </Text>
              <TextInput
                testID="input-custom-cmd"
                value={customCmd}
                onChangeText={setCustomCmd}
                placeholder="type any shell command…"
                placeholderTextColor={C.textDim}
                style={styles.cmdInput}
                onSubmitEditing={() => {
                  if (customCmd.trim()) {
                    execute(customCmd);
                    setCustomCmd("");
                  }
                }}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="send"
              />
              <TouchableOpacity
                testID="btn-run-custom"
                style={[styles.runBtn, !customCmd.trim() && { opacity: 0.4 }]}
                disabled={!customCmd.trim() || running}
                onPress={() => {
                  execute(customCmd);
                  setCustomCmd("");
                }}
              >
                <Ionicons name="play" size={14} color={C.bg} />
                <Text style={styles.runBtnText}>RUN</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.helper}>
              tip: commands are simulated in preview. on your S10+ build, pipe via{" "}
              <Text style={{ color: C.cyan }}>su -c</Text>.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* PROFILE MODAL */}
      <Modal visible={profileModal} animationType="fade" transparent statusBarTranslucent hardwareAccelerated onRequestClose={() => setProfileModal(false)}>
        <View style={styles.modalWrap}>
          <View style={styles.modal}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>// profiles</Text>
              <TouchableOpacity testID="btn-close-profiles" onPress={() => setProfileModal(false)}>
                <Ionicons name="close" size={22} color={C.green} />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 480 }}>
              {profiles.map((p) => (
                <View key={p.id} style={styles.profileRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.profileName}>{p.name}</Text>
                    {!!p.description && <Text style={styles.profileDesc}>{p.description}</Text>}
                    {p.commands.map((c, i) => (
                      <Text key={i} style={styles.profileCmd} numberOfLines={1}>
                        {`  └ ${c}`}
                      </Text>
                    ))}
                  </View>
                  <View style={{ gap: 6 }}>
                    <TouchableOpacity
                      testID={`btn-run-${p.id}`}
                      onPress={() => runProfile(p)}
                      style={[styles.iconBtn, { backgroundColor: C.greenDim }]}
                    >
                      <Ionicons name="play" size={14} color={C.bg} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      testID={`btn-del-${p.id}`}
                      onPress={() =>
                        Alert.alert("Delete profile?", p.name, [
                          { text: "Cancel" },
                          { text: "Delete", style: "destructive", onPress: () => deleteProfile(p.id) },
                        ])
                      }
                      style={[styles.iconBtn, { borderWidth: 1, borderColor: C.red }]}
                    >
                      <Ionicons name="trash" size={14} color={C.red} />
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
              {profiles.length === 0 && (
                <Text style={{ color: C.textDim, fontFamily: MONO, padding: 16 }}>no profiles yet</Text>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* SAVE PROFILE MODAL */}
      <Modal visible={saveModal} animationType="fade" transparent statusBarTranslucent hardwareAccelerated onRequestClose={() => setSaveModal(false)}>
        <View style={styles.modalWrap}>
          <View style={styles.modal}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>// save profile</Text>
              <TouchableOpacity onPress={() => setSaveModal(false)}>
                <Ionicons name="close" size={22} color={C.green} />
              </TouchableOpacity>
            </View>
            <Text style={[styles.helper, { marginBottom: 8 }]}>
              snapshot all 12 quick-action commands using current $IFACE=
              <Text style={{ color: C.cyan }}>{iface}</Text> $CC=
              <Text style={{ color: C.cyan }}>{country}</Text>
            </Text>
            <View style={[styles.field, { marginBottom: 10 }]}>
              <Text style={styles.fieldLabel}>name</Text>
              <TextInput
                testID="input-profile-name"
                value={newProfileName}
                onChangeText={setNewProfileName}
                style={styles.fieldInput}
                placeholder="e.g. Country Lock JP"
                placeholderTextColor={C.textDim}
                autoCapitalize="none"
              />
            </View>
            <View style={[styles.field, { marginBottom: 14 }]}>
              <Text style={styles.fieldLabel}>description</Text>
              <TextInput
                testID="input-profile-desc"
                value={newProfileDesc}
                onChangeText={setNewProfileDesc}
                style={styles.fieldInput}
                placeholder="optional"
                placeholderTextColor={C.textDim}
              />
            </View>
            <TouchableOpacity testID="btn-confirm-save" onPress={saveProfile} style={styles.bigBtn}>
              <Ionicons name="save" size={16} color={C.bg} />
              <Text style={styles.bigBtnText}>SAVE</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    backgroundColor: C.panel,
  },
  headerTitle: { color: C.green, fontFamily: MONO, fontSize: 16, fontWeight: "700" },
  headerVer: { color: C.textDim, fontFamily: MONO, fontSize: 11, marginLeft: 4 },
  badge: { borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 3 },
  badgeText: { fontFamily: MONO, fontSize: 10, fontWeight: "700", letterSpacing: 1 },
  statusBar: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: C.panel2,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  statusItem: { fontFamily: MONO, fontSize: 11 },
  section: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 4 },
  sectionRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  sectionTitle: { color: C.greenDim, fontFamily: MONO, fontSize: 12, marginBottom: 8, letterSpacing: 0.5 },
  field: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 8 },
  fieldLabel: { color: C.textDim, fontFamily: MONO, fontSize: 10, marginBottom: 3 },
  fieldInput: { color: C.green, fontFamily: MONO, fontSize: 14, padding: 0, minHeight: 22 },
  smallBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 3,
  },
  smallBtnText: { color: C.green, fontFamily: MONO, fontSize: 10 },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  gridItem: {
    width: "48.5%",
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 4,
    padding: 10,
    marginBottom: 8,
    minHeight: 70,
  },
  gridLabel: { color: C.text, fontFamily: MONO, fontSize: 12, fontWeight: "600" },
  gridCmd: { color: C.greenDim, fontFamily: MONO, fontSize: 10 },
  profileCard: {
    width: 200,
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 4,
    padding: 12,
    gap: 6,
  },
  profileName: { color: C.green, fontFamily: MONO, fontSize: 13, fontWeight: "700" },
  profileDesc: { color: C.textDim, fontFamily: MONO, fontSize: 10 },
  profileCount: { color: C.cyan, fontFamily: MONO, fontSize: 10, marginTop: 4 },
  profileRow: {
    flexDirection: "row",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  profileCmd: { color: C.greenDim, fontFamily: MONO, fontSize: 10, marginTop: 2 },
  terminal: {
    backgroundColor: "#02050a",
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 4,
  },
  termIntro: { color: C.textDim, fontFamily: MONO, fontSize: 11, marginBottom: 8 },
  termPromptLine: { fontFamily: MONO, fontSize: 12 },
  termOut: { color: C.text, fontFamily: MONO, fontSize: 11, marginTop: 2, marginLeft: 4 },
  termMeta: { color: C.textDim, fontFamily: MONO, fontSize: 9, marginTop: 2 },
  cmdRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 4,
    paddingHorizontal: 10,
    gap: 6,
  },
  cmdInput: { flex: 1, color: C.green, fontFamily: MONO, fontSize: 13, paddingVertical: 10 },
  runBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: C.green,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 3,
  },
  runBtnText: { color: C.bg, fontFamily: MONO, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  helper: { color: C.textDim, fontFamily: MONO, fontSize: 10, marginTop: 8 },
  modalWrap: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.85)",
    justifyContent: "flex-end",
  },
  modal: {
    backgroundColor: C.panel,
    borderTopWidth: 1,
    borderColor: C.border,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    padding: 16,
    maxHeight: "85%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  modalTitle: { color: C.green, fontFamily: MONO, fontSize: 14, fontWeight: "700" },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  bigBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: C.green,
    paddingVertical: 12,
    borderRadius: 4,
  },
  bigBtnText: { color: C.bg, fontFamily: MONO, fontSize: 13, fontWeight: "800", letterSpacing: 2 },
});
