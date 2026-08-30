import React, { useEffect, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, Switch, StyleSheet, Platform } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { SshBackendConfig } from "../lib/sshConfig";

const C = {
  bg: "#04070a", panel: "#0a1116", panel2: "#0e1820", border: "#163041",
  green: "#00ff66", cyan: "#3ad7ff", red: "#ff3860", yellow: "#ffd400",
  text: "#cfeadb", textDim: "#6c8a82",
};
const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

export type SshStatus = "down" | "connecting" | "connected" | "error";

type Props = {
  config: SshBackendConfig;
  status: SshStatus;
  statusDetail: string;
  savedPw: boolean;
  savedKey: boolean;
  onApply: (cfg: SshBackendConfig, pw: string, key: string) => void;
  onDisconnect: () => void;
};

const STATUS_COLOR: Record<SshStatus, string> = {
  down: C.textDim, connecting: C.yellow, connected: C.green, error: C.red,
};

export default function SshBackendPanel({
  config, status, statusDetail, savedPw, savedKey, onApply, onDisconnect,
}: Props) {
  const [enabled, setEnabled] = useState(config.enabled);
  const [host, setHost] = useState(config.host);
  const [port, setPort] = useState(String(config.port));
  const [user, setUser] = useState(config.user);
  const [authMode, setAuthMode] = useState<"password" | "key">(config.authMode);
  const [pw, setPw] = useState("");   // blank keeps stored
  const [key, setKey] = useState(""); // blank keeps stored

  // Re-sync drafts if the persisted config changes underneath us.
  useEffect(() => {
    setEnabled(config.enabled); setHost(config.host); setPort(String(config.port));
    setUser(config.user); setAuthMode(config.authMode);
  }, [config]);

  const apply = () => {
    onApply(
      {
        enabled,
        host: host.trim(),
        port: parseInt(port || "0", 10) || 9922,
        user: user.trim() || "kali",
        authMode,
        fingerprint: config.fingerprint,
      },
      pw,
      key,
    );
    setPw(""); setKey("");
  };

  const connected = status === "connected";

  return (
    <View style={st.wrap}>
      <View style={st.headerRow}>
        <MaterialCommunityIcons name="lan-connect" size={16} color={enabled ? C.green : C.textDim} />
        <Text style={st.title}>{"// ssh backend (agnostic)"}</Text>
        <View style={{ flex: 1 }} />
        <View style={[st.dot, { backgroundColor: STATUS_COLOR[status] }]} />
        <Text style={[st.status, { color: STATUS_COLOR[status] }]}>{status}</Text>
      </View>

      <View style={st.enableRow}>
        <Switch
          value={enabled}
          onValueChange={setEnabled}
          trackColor={{ false: C.border, true: "#0a3a22" }}
          thumbColor={enabled ? C.green : C.textDim}
        />
        <Text style={st.enableLbl}>
          {"  route the kali backend over SSH instead of the local chroot"}
        </Text>
      </View>

      <Text style={st.hint}>
        For Kalidroid/Podroid: forward the VM sshd (22 → 9922) onto the device IP,
        then point this at that IP:9922. Works with zero device root.
      </Text>

      <View style={st.row}>
        <View style={{ flex: 2, marginRight: 8 }}>
          <Text style={st.lbl}>HOST</Text>
          <TextInput style={st.input} value={host} onChangeText={setHost}
            autoCapitalize="none" autoCorrect={false}
            placeholder="device LAN / tailscale IP" placeholderTextColor={C.textDim} />
        </View>
        <View style={{ width: 78, marginRight: 8 }}>
          <Text style={st.lbl}>PORT</Text>
          <TextInput style={st.input} value={port} onChangeText={setPort}
            keyboardType="numeric" placeholder="9922" placeholderTextColor={C.textDim} />
        </View>
        <View style={{ width: 90 }}>
          <Text style={st.lbl}>USER</Text>
          <TextInput style={st.input} value={user} onChangeText={setUser}
            autoCapitalize="none" autoCorrect={false}
            placeholder="kali" placeholderTextColor={C.textDim} />
        </View>
      </View>

      <View style={st.authRow}>
        {(["password", "key"] as const).map((m) => {
          const active = authMode === m;
          return (
            <TouchableOpacity key={m} onPress={() => setAuthMode(m)}
              style={[st.authBtn, active && { backgroundColor: C.green, borderColor: C.green }]}>
              <Text style={[st.authTxt, { color: active ? C.bg : C.green }]}>{m.toUpperCase()}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {authMode === "password" ? (
        <View style={{ marginTop: 8 }}>
          <Text style={st.lbl}>PASSWORD</Text>
          <TextInput style={st.input} value={pw} onChangeText={setPw}
            secureTextEntry autoCapitalize="none" autoCorrect={false}
            placeholder={savedPw ? "•••••• (saved)" : "kali"} placeholderTextColor={C.textDim} />
        </View>
      ) : (
        <View style={{ marginTop: 8 }}>
          <Text style={st.lbl}>PRIVATE KEY (PEM)</Text>
          <TextInput style={[st.input, st.keyInput]} value={key} onChangeText={setKey}
            multiline autoCapitalize="none" autoCorrect={false}
            placeholder={savedKey ? "•••••• key saved — paste to replace" : "-----BEGIN OPENSSH PRIVATE KEY-----"}
            placeholderTextColor={C.textDim} />
        </View>
      )}

      {config.fingerprint ? (
        <Text style={st.fp}>trusted host key: {config.fingerprint}</Text>
      ) : null}
      {status === "error" && statusDetail ? (
        <Text style={[st.fp, { color: C.red }]}>⚠ {statusDetail}</Text>
      ) : null}

      <View style={st.actions}>
        <TouchableOpacity onPress={apply} style={[st.btn, { backgroundColor: C.green }]}>
          <Text style={[st.btnTxt, { color: C.bg }]}>{connected ? "APPLY & RECONNECT" : "APPLY & CONNECT"}</Text>
        </TouchableOpacity>
        {connected ? (
          <TouchableOpacity onPress={onDisconnect} style={[st.btn, st.btnGhost]}>
            <Text style={[st.btnTxt, { color: C.red }]}>DISCONNECT</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { marginTop: 12, backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: 8, padding: 12 },
  headerRow: { flexDirection: "row", alignItems: "center" },
  title: { color: C.green, fontFamily: MONO, fontSize: 11, fontWeight: "800", letterSpacing: 1, marginLeft: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  status: { fontFamily: MONO, fontSize: 9, letterSpacing: 1 },
  enableRow: { flexDirection: "row", alignItems: "center", marginTop: 10 },
  enableLbl: { color: C.text, fontFamily: MONO, fontSize: 11, flex: 1 },
  hint: { color: C.textDim, fontFamily: MONO, fontSize: 9, lineHeight: 13, marginTop: 8 },
  row: { flexDirection: "row", marginTop: 10 },
  lbl: { color: C.textDim, fontFamily: MONO, fontSize: 9, letterSpacing: 1, marginBottom: 3 },
  input: {
    backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: 4,
    color: C.text, fontFamily: MONO, fontSize: 12, paddingHorizontal: 8, paddingVertical: 7,
  },
  keyInput: { height: 88, textAlignVertical: "top" },
  authRow: { flexDirection: "row", marginTop: 10 },
  authBtn: { borderWidth: 1, borderColor: C.green, borderRadius: 4, paddingHorizontal: 14, paddingVertical: 6, marginRight: 8 },
  authTxt: { fontFamily: MONO, fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  fp: { color: C.cyan, fontFamily: MONO, fontSize: 9, marginTop: 8 },
  actions: { flexDirection: "row", marginTop: 12 },
  btn: { borderRadius: 4, paddingHorizontal: 14, paddingVertical: 10, marginRight: 8, alignItems: "center" },
  btnGhost: { backgroundColor: "transparent", borderWidth: 1, borderColor: C.red },
  btnTxt: { fontFamily: MONO, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
});
