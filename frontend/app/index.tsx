import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { HAS_NATIVE_ROOT, checkRoot, execReal, RootShell } from "../src/lib/rootShell";

const API = `${process.env.EXPO_PUBLIC_BACKEND_URL}/api`;

// Kali palette
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
  magenta: "#ff5cdb",
  text: "#cfeadb",
  textDim: "#6c8a82",
  prompt: "#5cffb1",
};

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

const BANNER = `\
 _    _ _____   _____      ___  _ ___ ___ ___  ___ ___ ___ ___ 
| |/\\/ |_ _\\ \\ / /__\\    | __|| | __/ _ \\ _ \\/ __| __| _ \\___|
| /  \\ || | \\ V /| _|    | _| | | _| (_) /  /| (__| _||   /___|
|_/\\__/|___| |_| |__|    |___||_|_| \\___/_|_\\ \\___|___|_|_\\
`;

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

type Ctx = { iface: string; country: string };

const QUICK_COMMANDS: { label: string; cmd: (c: Ctx) => string; icon: any }[] = [
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

// ---------- Syntax tinting ----------
const TOKEN_COLORS: Record<string, string> = {
  svc: C.cyan, cmd: C.cyan, ifconfig: C.cyan, iw: C.cyan, iwconfig: C.cyan,
  setprop: C.magenta, getprop: C.magenta, settings: C.magenta, ip: C.cyan, su: C.yellow,
  echo: C.yellow, id: C.yellow, whoami: C.yellow,
};

function HighlightedCmd({ cmd }: { cmd: string }) {
  const parts = cmd.split(/(\s+)/);
  const first = parts.find((p) => p.trim()) || "";
  const firstColor = TOKEN_COLORS[first] || C.text;
  let coloredFirst = false;
  return (
    <Text style={{ fontFamily: MONO, fontSize: 12 }}>
      {parts.map((p, i) => {
        if (!p.trim()) return p;
        if (!coloredFirst) {
          coloredFirst = true;
          return <Text key={i} style={{ color: firstColor, fontWeight: "700" }}>{p}</Text>;
        }
        if (p.startsWith("--") || p.startsWith("-")) return <Text key={i} style={{ color: C.yellow }}>{p}</Text>;
        if (/^[A-Z]{2}$/.test(p)) return <Text key={i} style={{ color: C.magenta }}>{p}</Text>;
        return <Text key={i} style={{ color: C.text }}>{p}</Text>;
      })}
    </Text>
  );
}

// ============================================================
export default function App() {
  const [tab, setTab] = useState<"quick" | "terminal" | "profiles" | "settings">("quick");
  const [iface, setIface] = useState("wlan2");
  const [country, setCountry] = useState("US");
  const [logs, setLogs] = useState<Log[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [customCmd, setCustomCmd] = useState("");
  const [running, setRunning] = useState(false);
  const [rootInfo, setRootInfo] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [importText, setImportText] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileDesc, setNewProfileDesc] = useState("");
  const [realMode, setRealMode] = useState(false);
  const [bridgeRoot, setBridgeRoot] = useState<boolean | null>(null);
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

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Detect native bridge & root status (only present in built APK; null in Expo Go/web)
  useEffect(() => {
    if (!HAS_NATIVE_ROOT) return;
    checkRoot().then(setBridgeRoot).catch(() => setBridgeRoot(false));
  }, []);

  // If bridge becomes unavailable, force back to mock
  useEffect(() => {
    if (!HAS_NATIVE_ROOT) setRealMode(false);
  }, []);

  useEffect(() => {
    if (tab !== "terminal") return;
    const t = setTimeout(() => termRef.current?.scrollToEnd({ animated: true }), 80);
    return () => clearTimeout(t);
  }, [logs, tab]);

  const execute = useCallback(async (command: string) => {
    if (!command.trim() || running) return;
    setRunning(true);
    try {
      if (realMode && HAS_NATIVE_ROOT) {
        const r = await execReal(command);
        setLogs((p) => [...p, {
          id: String(Date.now()) + Math.random(),
          timestamp: new Date().toISOString(),
          ...r,
        } as Log]);
      } else {
        const res = await fetch(`${API}/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command }),
        });
        const data: Log = await res.json();
        setLogs((p) => [...p, data]);
      }
    } catch (e: any) {
      setLogs((p) => [...p, {
        id: String(Date.now()), command, output: `[err] ${e?.message || e}`,
        exit_code: 1, duration_ms: 0, mocked: !realMode, timestamp: new Date().toISOString(),
      }]);
    } finally { setRunning(false); }
  }, [running, realMode]);

  const runProfile = useCallback(async (p: Profile) => {
    setRunning(true);
    try {
      if (realMode && HAS_NATIVE_ROOT && RootShell) {
        const data = await RootShell.execBatch(p.commands);
        const mapped: Log[] = data.logs.map((l: any) => ({
          id: String(Date.now()) + Math.random(),
          command: l.command, output: l.stdout || l.stderr || "",
          exit_code: l.exit_code, duration_ms: 0, mocked: false,
          timestamp: new Date().toISOString(),
        }));
        setLogs((prev) => [...prev, ...mapped]);
      } else {
        const res = await fetch(`${API}/profiles/${p.id}/run`, { method: "POST" });
        const data = await res.json();
        setLogs((prev) => [...prev, ...(data.logs as Log[])]);
      }
      setTab("terminal");
    } catch (e) { console.warn(e); }
    finally { setRunning(false); }
  }, [realMode]);

  const deleteProfile = useCallback(async (id: string) => {
    await fetch(`${API}/profiles/${id}`, { method: "DELETE" });
    fetchAll();
  }, [fetchAll]);

  const clearLogs = useCallback(async () => {
    await fetch(`${API}/logs`, { method: "DELETE" });
    setLogs([]);
  }, []);

  const saveCurrentAsProfile = useCallback(async () => {
    if (!newProfileName.trim()) { Alert.alert("Name required"); return; }
    const cmds = QUICK_COMMANDS.map((q) => q.cmd(ctx));
    await fetch(`${API}/profiles`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newProfileName.trim(), description: newProfileDesc.trim(), commands: cmds }),
    });
    setSaveOpen(false); setNewProfileName(""); setNewProfileDesc(""); fetchAll();
  }, [newProfileName, newProfileDesc, ctx, fetchAll]);

  const exportJson = useMemo(() => JSON.stringify(
    profiles.map(({ id, created_at, ...rest }) => rest), null, 2
  ), [profiles]);

  const importProfiles = useCallback(async () => {
    try {
      const parsed = JSON.parse(importText);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      let added = 0;
      for (const p of arr) {
        if (!p?.name || !Array.isArray(p?.commands)) continue;
        await fetch(`${API}/profiles`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: String(p.name), description: String(p.description || ""),
            commands: p.commands.map(String),
          }),
        });
        added++;
      }
      Alert.alert("Import complete", `Added ${added} profile${added === 1 ? "" : "s"}`);
      setImportText(""); setImportOpen(false); fetchAll();
    } catch (e: any) {
      Alert.alert("Import failed", e?.message || "Invalid JSON");
    }
  }, [importText, fetchAll]);

  // ---------- TAB RENDERERS ----------
  const renderQuick = () => (
    <ScrollView
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await fetchAll(); setRefreshing(false); }} tintColor={C.green} />}
    >
      <Text style={s.sectionTitle}>// context</Text>
      <View style={{ flexDirection: "row" }}>
        <View style={[s.field, { flex: 1, marginRight: 10 }]}>
          <Text style={s.fieldLabel}>$IFACE</Text>
          <TextInput testID="input-iface" value={iface} onChangeText={setIface}
            style={s.fieldInput} placeholder="wlan0" placeholderTextColor={C.textDim}
            autoCapitalize="none" autoCorrect={false} />
        </View>
        <View style={[s.field, { width: 110 }]}>
          <Text style={s.fieldLabel}>$CC</Text>
          <TextInput testID="input-country" value={country}
            onChangeText={(t) => setCountry(t.toUpperCase().slice(0, 2))}
            style={s.fieldInput} placeholder="US" placeholderTextColor={C.textDim}
            autoCapitalize="characters" maxLength={2} />
        </View>
      </View>

      <View style={[s.sectionRow, { marginTop: 24 }]}>
        <Text style={s.sectionTitle}>// quick actions</Text>
        <TouchableOpacity testID="btn-save-profile" onPress={() => setSaveOpen(true)} style={s.smallBtn}>
          <Ionicons name="bookmark-outline" size={12} color={C.green} />
          <Text style={s.smallBtnText}>save as profile</Text>
        </TouchableOpacity>
      </View>

      <View style={s.grid}>
        {QUICK_COMMANDS.map((q, i) => {
          const cmd = q.cmd(ctx);
          return (
            <TouchableOpacity key={i} testID={`quick-${i}`} style={s.gridItem}
              onPress={() => { execute(cmd); setTab("terminal"); }} disabled={running} activeOpacity={0.7}>
              <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 4 }}>
                <MaterialCommunityIcons name={q.icon} size={16} color={C.green} />
                <Text style={[s.gridLabel, { marginLeft: 6 }]}>{q.label}</Text>
              </View>
              <Text style={s.gridCmd} numberOfLines={1}>{cmd}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <Text style={[s.helper, { marginTop: 18 }]}>
        tip: tapping any action runs it (mocked) & jumps to terminal.
      </Text>
    </ScrollView>
  );

  const renderTerminal = () => (
    <View style={{ flex: 1 }}>
      <ScrollView ref={termRef} style={{ flex: 1, backgroundColor: "#02050a" }}
        contentContainerStyle={{ padding: 12, paddingBottom: 24 }}>
        <Text style={s.banner}>{BANNER}</Text>
        <Text style={s.bannerSub}>
          {`# session: ${rootInfo?.device || "..."} · ${rootInfo?.android_version || "..."}\n# entries: ${logs.length} · status: ${running ? "BUSY" : "idle"}\n`}
        </Text>
        {logs.map((l) => (
          <View key={l.id} style={{ marginBottom: 10 }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
              <Text style={{ color: C.prompt, fontFamily: MONO, fontSize: 12 }}>root@android</Text>
              <Text style={{ color: C.textDim, fontFamily: MONO, fontSize: 12 }}>:/ # </Text>
              <HighlightedCmd cmd={l.command} />
            </View>
            {!!l.output && (
              <Text style={[s.termOut, l.exit_code !== 0 && { color: C.red }]} selectable>
                {l.output}
              </Text>
            )}
            <Text style={s.termMeta}>
              <Text style={{ color: l.exit_code === 0 ? C.greenDim : C.red }}>exit={l.exit_code}</Text>
              <Text style={{ color: C.textDim }}> · {l.duration_ms}ms · {l.mocked ? "mock" : "real"}</Text>
            </Text>
          </View>
        ))}
        {logs.length === 0 && (
          <Text style={{ color: C.textDim, fontFamily: MONO, fontSize: 12 }}>
            (no commands yet — go to Quick or type below)
          </Text>
        )}
      </ScrollView>

      <View style={s.cmdRow}>
        <Text style={{ color: C.prompt, fontFamily: MONO, fontSize: 13 }}># </Text>
        <TextInput testID="input-custom-cmd" value={customCmd} onChangeText={setCustomCmd}
          placeholder="su -c …" placeholderTextColor={C.textDim} style={s.cmdInput}
          onSubmitEditing={() => { if (customCmd.trim()) { execute(customCmd); setCustomCmd(""); } }}
          autoCapitalize="none" autoCorrect={false} returnKeyType="send" />
        {running && <ActivityIndicator size="small" color={C.green} style={{ marginRight: 6 }} />}
        <TouchableOpacity testID="btn-run-custom"
          style={[s.runBtn, !customCmd.trim() && { opacity: 0.4 }]}
          disabled={!customCmd.trim() || running}
          onPress={() => { execute(customCmd); setCustomCmd(""); }}>
          <Ionicons name="play" size={14} color={C.bg} />
          <Text style={s.runBtnText}>RUN</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderProfiles = () => (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
      <View style={s.sectionRow}>
        <Text style={s.sectionTitle}>// profiles ({profiles.length})</Text>
        <TouchableOpacity testID="btn-save-profile-tab" onPress={() => setSaveOpen(true)} style={s.smallBtn}>
          <Ionicons name="add" size={14} color={C.green} />
          <Text style={s.smallBtnText}>new from quick</Text>
        </TouchableOpacity>
      </View>
      {profiles.map((p) => (
        <View key={p.id} style={s.profileBlock}>
          <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
            <View style={{ flex: 1 }}>
              <Text style={s.profileName}>{p.name}</Text>
              {!!p.description && <Text style={s.profileDesc}>{p.description}</Text>}
              <Text style={s.profileCount}>{p.commands.length} cmd{p.commands.length === 1 ? "" : "s"}</Text>
            </View>
            <View style={{ flexDirection: "row" }}>
              <TouchableOpacity testID={`btn-run-${p.id}`} onPress={() => runProfile(p)}
                style={[s.iconBtn, { backgroundColor: C.green, marginRight: 6 }]} disabled={running}>
                <Ionicons name="play" size={14} color={C.bg} />
              </TouchableOpacity>
              <TouchableOpacity testID={`btn-del-${p.id}`}
                onPress={() => Alert.alert("Delete?", p.name, [
                  { text: "Cancel" },
                  { text: "Delete", style: "destructive", onPress: () => deleteProfile(p.id) },
                ])}
                style={[s.iconBtn, { borderWidth: 1, borderColor: C.red }]}>
                <Ionicons name="trash" size={14} color={C.red} />
              </TouchableOpacity>
            </View>
          </View>
          <View style={s.profileCmds}>
            {p.commands.map((c, i) => (
              <View key={i} style={{ flexDirection: "row" }}>
                <Text style={{ color: C.textDim, fontFamily: MONO, fontSize: 11 }}>  └ </Text>
                <HighlightedCmd cmd={c} />
              </View>
            ))}
          </View>
        </View>
      ))}
      {profiles.length === 0 && (
        <Text style={{ color: C.textDim, fontFamily: MONO, padding: 16, textAlign: "center" }}>no profiles yet</Text>
      )}
    </ScrollView>
  );

  const renderSettings = () => (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
      <Text style={s.sectionTitle}>// system</Text>
      <View style={s.kvBlock}>
        <KV k="exec mode" v={realMode ? "REAL · su -c" : "MOCK"} vColor={realMode ? C.green : C.yellow} />
        <KV k="bridge" v={HAS_NATIVE_ROOT ? (bridgeRoot ? "loaded · root granted" : bridgeRoot === false ? "loaded · root denied" : "loaded · checking…") : "absent (Expo Go / web)"} vColor={HAS_NATIVE_ROOT ? (bridgeRoot ? C.green : C.red) : C.textDim} />
        <KV k="root" v={rootInfo?.root_granted ? "GRANTED" : "..."} vColor={rootInfo?.root_granted ? C.green : C.red} />
        <KV k="device" v={rootInfo?.device || "..."} vColor={C.cyan} />
        <KV k="os" v={rootInfo?.android_version || "..."} vColor={C.cyan} />
        <KV k="api" v={API} vColor={C.textDim} />
      </View>

      <Text style={[s.sectionTitle, { marginTop: 24 }]}>// execution</Text>
      <TouchableOpacity testID="btn-toggle-real"
        onPress={() => {
          if (!HAS_NATIVE_ROOT) {
            Alert.alert("Bridge not present", "REAL mode requires the built APK. See /app/root-bridge/README.md.");
            return;
          }
          if (!bridgeRoot && !realMode) {
            Alert.alert("Root not granted", "Open Magisk and grant root for WiFi Enforcer, then try again.");
            return;
          }
          setRealMode((v) => !v);
        }}
        style={[s.row, !HAS_NATIVE_ROOT && { opacity: 0.6 }]}>
        <MaterialCommunityIcons name={realMode ? "shield-check" : "shield-outline"} size={16} color={realMode ? C.green : C.yellow} />
        <Text style={[s.rowText, { color: realMode ? C.green : C.yellow }]}>
          {realMode ? "REAL mode — commands hit `su -c`" : "MOCK mode — commands simulated"}
        </Text>
        <View style={[s.toggle, realMode && { backgroundColor: C.green }]}>
          <View style={[s.toggleKnob, realMode && { left: 18 }]} />
        </View>
      </TouchableOpacity>
      {!HAS_NATIVE_ROOT && (
        <Text style={s.helper}>
          REAL mode is only available in the standalone APK. Build instructions ↓
        </Text>
      )}

      <Text style={[s.sectionTitle, { marginTop: 24 }]}>// data</Text>
      <TouchableOpacity testID="btn-export" onPress={() => setExportOpen((v) => !v)} style={s.row}>
        <Ionicons name="download-outline" size={16} color={C.green} />
        <Text style={s.rowText}>export profiles ({profiles.length})</Text>
        <Ionicons name={exportOpen ? "chevron-up" : "chevron-down"} size={16} color={C.textDim} />
      </TouchableOpacity>
      {exportOpen && (
        <View style={s.codeBlock}>
          <Text selectable style={s.codeText}>{exportJson}</Text>
          <Text style={s.helper}>long-press → select all → copy</Text>
        </View>
      )}

      <TouchableOpacity testID="btn-import" onPress={() => setImportOpen((v) => !v)} style={s.row}>
        <Ionicons name="cloud-upload-outline" size={16} color={C.green} />
        <Text style={s.rowText}>import profiles (paste JSON)</Text>
        <Ionicons name={importOpen ? "chevron-up" : "chevron-down"} size={16} color={C.textDim} />
      </TouchableOpacity>
      {importOpen && (
        <View>
          <TextInput testID="input-import" value={importText} onChangeText={setImportText}
            placeholder='[{"name":"...","commands":["..."]}]' placeholderTextColor={C.textDim}
            style={s.importBox} multiline autoCapitalize="none" autoCorrect={false} />
          <TouchableOpacity testID="btn-confirm-import" onPress={importProfiles} style={s.bigBtn}>
            <Ionicons name="cloud-upload" size={14} color={C.bg} />
            <Text style={s.bigBtnText}>IMPORT</Text>
          </TouchableOpacity>
        </View>
      )}

      <Text style={[s.sectionTitle, { marginTop: 24 }]}>// danger zone</Text>
      <TouchableOpacity testID="btn-clear-logs" onPress={() => Alert.alert("Clear all logs?", "", [
        { text: "Cancel" }, { text: "Clear", style: "destructive", onPress: clearLogs },
      ])} style={[s.row, { borderColor: C.red }]}>
        <Ionicons name="trash-outline" size={16} color={C.red} />
        <Text style={[s.rowText, { color: C.red }]}>clear all terminal logs</Text>
      </TouchableOpacity>

      <Text style={[s.sectionTitle, { marginTop: 24 }]}>// real root</Text>
      <View style={s.infoBox}>
        <Text style={s.infoText}>
          {`Preview executes commands via mock. To run real \`su -c\` on your S10+:\n\n`}
          <Text style={{ color: C.cyan }}>1.</Text>{` See /app/root-bridge/README.md\n`}
          <Text style={{ color: C.cyan }}>2.</Text>{` Build APK: \`eas build -p android --profile preview\`\n`}
          <Text style={{ color: C.cyan }}>3.</Text>{` Sideload + grant root in Magisk\n\n`}
          <Text style={{ color: C.yellow }}>{`The Kotlin native module (RootShellModule.kt) is already scaffolded.`}</Text>
        </Text>
      </View>

      <Text style={[s.helper, { marginTop: 24, textAlign: "center" }]}>wifi-enforcer · v0.1 · mocked preview</Text>
    </ScrollView>
  );

  return (
    <SafeAreaView style={s.safe} edges={["top", "bottom"]}>
      <StatusBar style="light" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        {/* HEADER */}
        <View style={s.header} testID="app-header">
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <MaterialCommunityIcons name="shield-lock" size={20} color={C.green} />
            <Text style={[s.headerTitle, { marginLeft: 8 }]}>wifi-enforcer</Text>
            <Text style={s.headerVer}>v0.1</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            {running && <ActivityIndicator size="small" color={C.green} style={{ marginRight: 8 }} />}
            <View style={[s.badge, { borderColor: realMode ? C.green : C.yellow }]}>
              <Text style={[s.badgeText, { color: realMode ? C.green : C.yellow }]}>{realMode ? "REAL" : "MOCK"}</Text>
            </View>
          </View>
        </View>

        {/* CONTENT */}
        <View style={{ flex: 1 }}>
          {tab === "quick" && renderQuick()}
          {tab === "terminal" && renderTerminal()}
          {tab === "profiles" && renderProfiles()}
          {tab === "settings" && renderSettings()}
        </View>

        {/* TAB BAR */}
        <View style={s.tabbar}>
          <TabBtn t="quick" cur={tab} icon="flash" label="quick" onPress={setTab} />
          <TabBtn t="terminal" cur={tab} icon="terminal" label="term" badge={logs.length} onPress={setTab} />
          <TabBtn t="profiles" cur={tab} icon="bookmark-multiple" label="profiles" badge={profiles.length} onPress={setTab} />
          <TabBtn t="settings" cur={tab} icon="cog" label="settings" onPress={setTab} />
        </View>

        {/* SAVE PROFILE INLINE PANEL */}
        {saveOpen && (
          <View style={s.overlay}>
            <View style={s.sheet}>
              <View style={s.sheetHeader}>
                <Text style={s.sheetTitle}>// save profile</Text>
                <TouchableOpacity onPress={() => setSaveOpen(false)} testID="btn-close-save">
                  <Ionicons name="close" size={22} color={C.green} />
                </TouchableOpacity>
              </View>
              <Text style={s.helper}>
                snapshot all 12 quick-action commands using $IFACE=
                <Text style={{ color: C.cyan }}>{iface}</Text> $CC=
                <Text style={{ color: C.cyan }}>{country}</Text>
              </Text>
              <View style={[s.field, { marginTop: 12 }]}>
                <Text style={s.fieldLabel}>name</Text>
                <TextInput testID="input-profile-name" value={newProfileName} onChangeText={setNewProfileName}
                  style={s.fieldInput} placeholder="e.g. Country Lock JP" placeholderTextColor={C.textDim} autoCapitalize="none" />
              </View>
              <View style={[s.field, { marginTop: 8 }]}>
                <Text style={s.fieldLabel}>description</Text>
                <TextInput testID="input-profile-desc" value={newProfileDesc} onChangeText={setNewProfileDesc}
                  style={s.fieldInput} placeholder="optional" placeholderTextColor={C.textDim} />
              </View>
              <TouchableOpacity testID="btn-confirm-save" onPress={saveCurrentAsProfile} style={[s.bigBtn, { marginTop: 14 }]}>
                <Ionicons name="save" size={16} color={C.bg} />
                <Text style={s.bigBtnText}>SAVE</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function KV({ k, v, vColor = C.text }: { k: string; v: string; vColor?: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 }}>
      <Text style={{ color: C.textDim, fontFamily: MONO, fontSize: 12 }}>{k}</Text>
      <Text style={{ color: vColor, fontFamily: MONO, fontSize: 12, flexShrink: 1, textAlign: "right" }}>{v}</Text>
    </View>
  );
}

function TabBtn({ t, cur, icon, label, badge, onPress }: { t: any; cur: any; icon: any; label: string; badge?: number; onPress: (t: any) => void }) {
  const active = t === cur;
  return (
    <TouchableOpacity testID={`tab-${t}`} onPress={() => onPress(t)} style={s.tabBtn} activeOpacity={0.7}>
      <View>
        <MaterialCommunityIcons name={icon} size={20} color={active ? C.green : C.textDim} />
        {badge !== undefined && badge > 0 && (
          <View style={s.tabBadge}><Text style={s.tabBadgeText}>{badge > 99 ? "99+" : badge}</Text></View>
        )}
      </View>
      <Text style={[s.tabLabel, { color: active ? C.green : C.textDim }]}>{label}</Text>
      {active && <View style={s.tabIndicator} />}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.panel,
  },
  headerTitle: { color: C.green, fontFamily: MONO, fontSize: 16, fontWeight: "700" },
  headerVer: { color: C.textDim, fontFamily: MONO, fontSize: 11, marginLeft: 4 },
  badge: { borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 3 },
  badgeText: { fontFamily: MONO, fontSize: 10, fontWeight: "700", letterSpacing: 1 },

  sectionTitle: { color: C.greenDim, fontFamily: MONO, fontSize: 12, marginBottom: 10, letterSpacing: 0.5 },
  sectionRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },

  field: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 8 },
  fieldLabel: { color: C.textDim, fontFamily: MONO, fontSize: 10, marginBottom: 3 },
  fieldInput: { color: C.green, fontFamily: MONO, fontSize: 14, padding: 0, minHeight: 22 },

  smallBtn: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 8, paddingVertical: 4,
    borderWidth: 1, borderColor: C.border, borderRadius: 3,
  },
  smallBtnText: { color: C.green, fontFamily: MONO, fontSize: 10, marginLeft: 4 },

  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  gridItem: {
    width: "48.5%", backgroundColor: C.panel, borderWidth: 1, borderColor: C.border,
    borderRadius: 4, padding: 10, marginBottom: 8, minHeight: 64,
  },
  gridLabel: { color: C.text, fontFamily: MONO, fontSize: 12, fontWeight: "600" },
  gridCmd: { color: C.greenDim, fontFamily: MONO, fontSize: 10 },

  banner: { color: C.green, fontFamily: MONO, fontSize: 8, lineHeight: 11 },
  bannerSub: { color: C.textDim, fontFamily: MONO, fontSize: 10, marginTop: 6, marginBottom: 12 },
  termOut: { color: C.text, fontFamily: MONO, fontSize: 11, marginTop: 2, marginLeft: 4 },
  termMeta: { fontFamily: MONO, fontSize: 9, marginTop: 2 },

  cmdRow: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: C.panel, borderTopWidth: 1, borderTopColor: C.border,
    paddingHorizontal: 10,
  },
  cmdInput: { flex: 1, color: C.green, fontFamily: MONO, fontSize: 13, paddingVertical: 12, marginLeft: 4 },
  runBtn: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: C.green, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 3,
    marginVertical: 6,
  },
  runBtnText: { color: C.bg, fontFamily: MONO, fontSize: 11, fontWeight: "800", letterSpacing: 1, marginLeft: 4 },

  profileBlock: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 12, marginBottom: 10 },
  profileName: { color: C.green, fontFamily: MONO, fontSize: 13, fontWeight: "700" },
  profileDesc: { color: C.textDim, fontFamily: MONO, fontSize: 10, marginTop: 2 },
  profileCount: { color: C.cyan, fontFamily: MONO, fontSize: 10, marginTop: 4 },
  profileCmds: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.border },

  iconBtn: { width: 32, height: 32, borderRadius: 4, alignItems: "center", justifyContent: "center" },

  helper: { color: C.textDim, fontFamily: MONO, fontSize: 10 },

  tabbar: {
    flexDirection: "row",
    backgroundColor: C.panel, borderTopWidth: 1, borderTopColor: C.border,
    paddingTop: 6, paddingBottom: 6,
  },
  tabBtn: { flex: 1, alignItems: "center", paddingVertical: 6 },
  tabLabel: { fontFamily: MONO, fontSize: 9, marginTop: 2, letterSpacing: 0.5 },
  tabIndicator: { position: "absolute", top: 0, height: 2, width: 24, backgroundColor: C.green, borderRadius: 1 },
  tabBadge: {
    position: "absolute", top: -4, right: -10, minWidth: 16, height: 14,
    paddingHorizontal: 3, borderRadius: 7, backgroundColor: C.greenDim,
    alignItems: "center", justifyContent: "center",
  },
  tabBadgeText: { color: C.bg, fontFamily: MONO, fontSize: 8, fontWeight: "800" },

  kvBlock: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 10 },

  row: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: 4,
    padding: 12, marginBottom: 8,
  },
  rowText: { color: C.green, fontFamily: MONO, fontSize: 12, marginLeft: 10, flex: 1 },

  toggle: {
    width: 38, height: 20, borderRadius: 10, backgroundColor: C.border,
    padding: 2, justifyContent: "center",
  },
  toggleKnob: {
    width: 16, height: 16, borderRadius: 8, backgroundColor: C.text,
    position: "absolute", left: 2, top: 2,
  },

  codeBlock: { backgroundColor: "#02050a", borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 10, marginBottom: 8 },
  codeText: { color: C.text, fontFamily: MONO, fontSize: 10 },

  importBox: {
    backgroundColor: "#02050a", borderWidth: 1, borderColor: C.border, borderRadius: 4,
    padding: 10, color: C.green, fontFamily: MONO, fontSize: 11, minHeight: 100,
    textAlignVertical: "top", marginBottom: 8,
  },

  bigBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: C.green, paddingVertical: 12, borderRadius: 4,
  },
  bigBtnText: { color: C.bg, fontFamily: MONO, fontSize: 13, fontWeight: "800", letterSpacing: 2, marginLeft: 6 },

  infoBox: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 12 },
  infoText: { color: C.text, fontFamily: MONO, fontSize: 11, lineHeight: 16 },

  overlay: {
    position: "absolute", left: 0, right: 0, top: 0, bottom: 0,
    backgroundColor: "rgba(0,0,0,0.85)", justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: C.panel, borderTopWidth: 1, borderColor: C.border,
    borderTopLeftRadius: 8, borderTopRightRadius: 8, padding: 16,
  },
  sheetHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  sheetTitle: { color: C.green, fontFamily: MONO, fontSize: 14, fontWeight: "700" },
});
