/**
 * ProvisionNodeModal — guided, cockpit-first node install.
 *
 * Collects connection + config details, then runs nodeProvision.provisionNode
 * end-to-end (bootstrap key → install .deb over the tailnet → finalize config
 * → start + health-check). Streams progress into a log pane. On success it
 * hands a node draft back to the caller to persist into the roster.
 *
 * Self-contained: builds its own chroot exec + reuses the existing deploy
 * plumbing (prepareDebPayload / detectTailscaleIp / startHttpServer) to serve
 * the bundled .deb to the target.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  Modal, Platform, Switch, KeyboardAvoidingView,
} from "react-native";
import * as Crypto from "expo-crypto";
import { execReal, HAS_NATIVE_ROOT } from "../lib/rootShell";
import { settingsLocal } from "../lib/localDb";
import {
  prepareDebPayload, detectTailscaleIp, startHttpServer, stopHttpServer,
  DEPLOY_DEB_NAME,
} from "../lib/deployServer";
import { provisionNode, type ProvisionResult } from "../lib/nodeProvision";
import { loadUpstashUrl } from "../lib/tokenStash";

const C = {
  bg: "#04070a", panel: "#0a1116", panel2: "#0e1820", border: "#163041",
  green: "#00ff66", cyan: "#3ad7ff", red: "#ff3860", yellow: "#ffd400",
  text: "#cfeadb", textDim: "#6c8a82", mcpAccent: "#7df9ff",
};
const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

async function genBearer(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(32);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type NodeDraft = {
  name: string; host: string; port: number; bearer_token: string;
  is_systemd: boolean | null; description: string;
};

export default function ProvisionNodeModal(props: {
  visible: boolean;
  onClose: () => void;
  onProvisioned: (draft: NodeDraft) => void;
}) {
  const { visible, onClose, onProvisioned } = props;

  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [authMode, setAuthMode] = useState<"password" | "tailscale">("password");
  const [sshUser, setSshUser] = useState("root");
  const [sshPass, setSshPass] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [mcpPort, setMcpPort] = useState("8765");
  const [bindHost, setBindHost] = useState("0.0.0.0");
  const [bearer, setBearer] = useState("");
  const [cloudUrl, setCloudUrl] = useState("");
  const [cloudToken, setCloudToken] = useState("");
  const [installCron, setInstallCron] = useState(true);

  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string>("");
  const [done, setDone] = useState<ProvisionResult | null>(null);

  // Seed a bearer + prefill cloud URL when the modal opens.
  useEffect(() => {
    if (!visible) return;
    setDone(null);
    setLog("");
    (async () => {
      if (!bearer) setBearer(await genBearer());
      const u = await loadUpstashUrl();
      if (u && !cloudUrl) setCloudUrl(u);
    })().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const appendLog = useCallback((line: string) => {
    setLog((prev) => {
      const next = prev ? prev + "\n" + line : line;
      return next.length > 8000 ? next.slice(-8000) : next;
    });
  }, []);

  // Chroot-wrapped exec, mirroring MCPTab.wrapChrootCmd behaviour.
  const execChroot = useCallback(async (inner: string) => {
    const s = await settingsLocal.get();
    const chrootPath = (s.chroot_path || "").trim();
    const escaped = inner.replace(/'/g, "'\\''");
    const cmd = chrootPath ? `${chrootPath} bash -c '${escaped}'` : inner;
    const r = await execReal(cmd);
    return { output: r.output, exit_code: r.exit_code };
  }, []);

  const handleProvision = useCallback(async () => {
    if (!HAS_NATIVE_ROOT) {
      appendLog("✗ root shell unavailable — provisioning needs the deployed APK (not Expo Go / web).");
      return;
    }
    if (!host.trim()) {
      appendLog("✗ host is required.");
      return;
    }
    if (authMode === "password" && !sshPass) {
      appendLog("✗ SSH password is required for password mode (or switch to Tailscale SSH).");
      return;
    }
    if (!bearer) { appendLog("✗ bearer token empty — tap REGEN."); return; }

    setRunning(true);
    setDone(null);
    let debHandleId: string | null = null;
    try {
      // 1) Stage the bundled .deb + serve it over the tailnet.
      appendLog("• staging bundled .deb inside chroot…");
      await prepareDebPayload();
      const ip = await detectTailscaleIp();
      if (!ip) throw new Error("no tailnet IP on this device — is Tailscale up?");
      const servePort = 8091;
      appendLog(`• serving .deb on http://${ip}:${servePort}/${DEPLOY_DEB_NAME}`);
      const h = await startHttpServer({
        ip, port: servePort,
        onError: (m) => appendLog(`  [httpd error] ${m}`),
      });
      debHandleId = h.sessionId;
      const debUrl = `http://${ip}:${servePort}/${DEPLOY_DEB_NAME}`;

      // 2) Run the full provision.
      const res = await provisionNode(
        {
          host: host.trim(),
          authMode,
          sshUser: sshUser.trim() || "root",
          sshPass,
          sshPort: parseInt(sshPort, 10) || 22,
          bearerToken: bearer,
          bindHost: bindHost.trim() || "0.0.0.0",
          mcpPort: parseInt(mcpPort, 10) || 8765,
          cloudUrl: cloudUrl.trim() || undefined,
          cloudToken: cloudToken.trim() || undefined,
          installCron,
          debUrl,
        },
        execChroot,
        appendLog,
      );
      setDone(res);
      appendLog(res.ok ? `\n✓ ${res.detail}` : `\n✗ [${res.stage}] ${res.detail}`);
    } catch (e: any) {
      appendLog(`\n✗ ${e?.message || e}`);
      setDone({ ok: false, stage: "exception", isSystemd: null, detail: e?.message || String(e) });
    } finally {
      if (debHandleId) await stopHttpServer(debHandleId).catch(() => {});
      setRunning(false);
    }
  }, [host, sshUser, sshPass, sshPort, mcpPort, bindHost, bearer, cloudUrl, cloudToken, installCron, authMode, execChroot, appendLog]);

  const handleSaveToRoster = useCallback(() => {
    onProvisioned({
      name: name.trim() || host.trim(),
      host: host.trim(),
      port: parseInt(mcpPort, 10) || 8765,
      bearer_token: bearer,
      is_systemd: done?.isSystemd ?? null,
      description: `provisioned ${new Date().toISOString().slice(0, 16)}${done?.isSystemd === false ? " (sysv)" : ""}`,
    });
    onClose();
  }, [name, host, mcpPort, bearer, done, onProvisioned, onClose]);

  const field = (
    label: string, value: string, setter: (v: string) => void,
    opts: { placeholder?: string; secure?: boolean; keyboard?: "default" | "numeric" } = {},
  ) => (
    <View style={{ marginBottom: 12 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        style={s.input}
        value={value}
        onChangeText={setter}
        placeholder={opts.placeholder}
        placeholderTextColor={C.textDim}
        secureTextEntry={opts.secure}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={opts.keyboard === "numeric" ? "numeric" : "default"}
        editable={!running}
      />
    </View>
  );

  return (
    <Modal visible={visible} animationType="none" transparent onRequestClose={onClose}>
      <View style={s.backdrop}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={s.card}
        >
          <View style={s.header}>
            <Text style={s.title}>{"// provision node"}</Text>
            <TouchableOpacity onPress={onClose} disabled={running} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={[s.headerBtn, running && { opacity: 0.4 }]}>CLOSE</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={{ flexGrow: 0 }} keyboardShouldPersistTaps="handled">
            <Text style={s.hint}>
              Installs enforcer-mcp on a new node over SSH. The root password is used ONCE to install the cockpit key — nothing on the node&apos;s login policy changes.
            </Text>

            {field("Node name", name, setName, { placeholder: "e.g. vps-fra-01" })}
            {field("Host (tailnet IP / DNS)", host, setHost, { placeholder: "100.x.y.z" })}

            {/* Auth mode selector */}
            <Text style={s.label}>Connect via</Text>
            <View style={[s.row, { marginBottom: 12 }]}>
              {([
                ["password", "Password (public IP)"],
                ["tailscale", "Tailscale SSH (tailnet)"],
              ] as const).map(([mode, lbl]) => {
                const active = authMode === mode;
                return (
                  <TouchableOpacity
                    key={mode}
                    style={[s.modeBtn, active && s.modeBtnActive, mode === "password" && { marginRight: 8 }]}
                    disabled={running}
                    onPress={() => setAuthMode(mode)}
                  >
                    <Text style={[s.modeBtnTxt, active && s.modeBtnTxtActive]}>{lbl}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={s.hintFine}>
              {authMode === "tailscale"
                ? "Uses `tailscale ssh` — tailnet identity is the auth, no password. Target needs `tailscale up --ssh` + an ACL grant. First use may need a one-time manual `tailscale ssh` to clear device auth."
                : "Normal SSH over a routable IP. The password is used ONCE to install the cockpit key; key-based thereafter."}
            </Text>

            <View style={s.row}>
              <View style={{ flex: 1, marginRight: 8 }}>{field("SSH user", sshUser, setSshUser, { placeholder: "root" })}</View>
              {authMode === "password" ? (
                <View style={{ width: 90 }}>{field("SSH port", sshPort, setSshPort, { keyboard: "numeric" })}</View>
              ) : null}
            </View>
            {authMode === "password"
              ? field("SSH password (used once)", sshPass, setSshPass, { secure: true, placeholder: "root password" })
              : null}

            <View style={s.row}>
              <View style={{ flex: 1, marginRight: 8 }}>{field("MCP port", mcpPort, setMcpPort, { keyboard: "numeric" })}</View>
              <View style={{ flex: 1 }}>{field("Bind host", bindHost, setBindHost, { placeholder: "0.0.0.0" })}</View>
            </View>

            <Text style={s.label}>Bearer token (this node)</Text>
            <View style={s.row}>
              <TextInput
                style={[s.input, { flex: 1, marginRight: 8 }]}
                value={bearer}
                onChangeText={setBearer}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!running}
              />
              <TouchableOpacity
                style={s.smallBtn}
                disabled={running}
                onPress={async () => setBearer(await genBearer())}
              >
                <Text style={s.smallBtnTxt}>REGEN</Text>
              </TouchableOpacity>
            </View>

            <View style={{ height: 12 }} />
            {field("Cloud URL (optional)", cloudUrl, setCloudUrl, { placeholder: "https://…upstash.io" })}
            {field("Cloud token (optional, read-only)", cloudToken, setCloudToken, { secure: true })}

            <View style={[s.row, { alignItems: "center", justifyContent: "space-between", marginBottom: 12 }]}>
              <Text style={s.label}>Install cron watchdog (non-systemd)</Text>
              <Switch
                value={installCron}
                onValueChange={setInstallCron}
                disabled={running}
                trackColor={{ true: C.green, false: C.border }}
                thumbColor={installCron ? C.green : C.textDim}
              />
            </View>

            {log ? (
              <View style={s.logBox}>
                <Text style={s.logTxt}>{log}</Text>
              </View>
            ) : null}
          </ScrollView>

          <View style={s.footer}>
            {done?.ok ? (
              <TouchableOpacity style={[s.actionBtn, { backgroundColor: C.green }]} onPress={handleSaveToRoster}>
                <Text style={[s.actionTxt, { color: "#04120a" }]}>SAVE TO ROSTER →</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[s.actionBtn, running && { opacity: 0.6 }]}
                disabled={running}
                onPress={handleProvision}
              >
                <Text style={s.actionTxt}>{running ? "PROVISIONING…  (watch the log)" : "PROVISION"}</Text>
              </TouchableOpacity>
            )}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  card: {
    backgroundColor: C.bg, borderTopLeftRadius: 16, borderTopRightRadius: 16,
    borderColor: C.border, borderWidth: 1, maxHeight: "92%", paddingHorizontal: 16, paddingBottom: 16,
  },
  header: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingVertical: 14, borderBottomColor: C.border, borderBottomWidth: 1, marginBottom: 12,
  },
  title: { color: C.mcpAccent, fontFamily: MONO, fontSize: 16, fontWeight: "700" },
  headerBtn: { color: C.textDim, fontFamily: MONO, fontSize: 13 },
  hint: { color: C.textDim, fontFamily: MONO, fontSize: 11, lineHeight: 16, marginBottom: 14 },
  hintFine: { color: C.textDim, fontFamily: MONO, fontSize: 10, lineHeight: 15, marginBottom: 12 },
  modeBtn: {
    flex: 1, backgroundColor: C.panel2, borderColor: C.border, borderWidth: 1,
    borderRadius: 8, paddingVertical: 10, alignItems: "center",
  },
  modeBtnActive: { borderColor: C.mcpAccent, backgroundColor: C.panel },
  modeBtnTxt: { color: C.textDim, fontFamily: MONO, fontSize: 11, fontWeight: "700" },
  modeBtnTxtActive: { color: C.mcpAccent },
  label: { color: C.text, fontFamily: MONO, fontSize: 12, marginBottom: 5 },
  input: {
    backgroundColor: C.panel2, borderColor: C.border, borderWidth: 1, borderRadius: 8,
    color: C.text, fontFamily: MONO, fontSize: 13, paddingHorizontal: 10, paddingVertical: 9,
  },
  row: { flexDirection: "row" },
  smallBtn: {
    backgroundColor: C.panel, borderColor: C.border, borderWidth: 1, borderRadius: 8,
    paddingHorizontal: 12, justifyContent: "center",
  },
  smallBtnTxt: { color: C.cyan, fontFamily: MONO, fontSize: 12, fontWeight: "700" },
  logBox: {
    backgroundColor: "#01040699", borderColor: C.border, borderWidth: 1, borderRadius: 8,
    padding: 10, marginTop: 6, marginBottom: 8,
  },
  logTxt: { color: C.green, fontFamily: MONO, fontSize: 11, lineHeight: 16 },
  footer: { paddingTop: 12, borderTopColor: C.border, borderTopWidth: 1 },
  actionBtn: {
    backgroundColor: C.panel, borderColor: C.mcpAccent, borderWidth: 1, borderRadius: 10,
    paddingVertical: 14, alignItems: "center",
  },
  actionTxt: { color: C.mcpAccent, fontFamily: MONO, fontSize: 14, fontWeight: "700", letterSpacing: 1 },
});
