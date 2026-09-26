/**
 * TerminalShell — multi-target persistent PTY terminal (Terminal tab).
 *
 * Targets (selector row, left→right):
 *   • kali    — the star: a persistent login shell on the active Kali backend
 *               (SSH ChannelShell in SSH mode, or a chroot `script` PTY on a
 *               rooted NetHunter device).
 *   • node ▼  — pick an ONLINE roster node and jump into it by injecting
 *               `ssh <user>@<host>` into the live Kali shell (same session —
 *               `exit` drops you back to Kali). Nodes come from the local
 *               roster, filtered to those last seen "running" (green).
 *   • local   — Android host root shell (su → host PTY). De-emphasised; only
 *               really useful for host-side things like `svc wifi disable`.
 *
 * Kali/node share ONE session (SSH transport); local is its OWN session on the
 * chroot/root transport. Both stay alive across focus flips because backend.ts
 * pins each session to the transport it was started on (per-session routing).
 *
 * There is no one-shot mode anymore — every target is a real, persistent PTY.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { sessionManager, SessionState } from "../lib/sessionManager";
import { hasNativeStreaming, HAS_NATIVE_ROOT } from "../lib/rootShell";
import { HAS_NATIVE_SSH } from "../lib/sshBackend";
import { writeStdin } from "../lib/backend";
import { nodesLocal, MCPNode } from "../lib/localDb";
import XTermView from "./XTermView";

const C = {
  bg: "#04070a", panel: "#0a1116", panel2: "#0e1820", border: "#163041",
  green: "#00ff66", greenDim: "#0a8a3a", cyan: "#3ad7ff",
  red: "#ff3860", yellow: "#ffd400", magenta: "#ff5cdb",
  text: "#cfeadb", textDim: "#6c8a82",
};
const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

type Target = "kali" | "local";

type Props = {
  /** Global transport for the Kali target: "ssh" (ChannelShell) or "chroot". */
  backendKind: "chroot" | "ssh";
  /** exec mode — only relevant when backendKind==="chroot" (mock gates the shell). */
  execMode: "mock" | "real" | "kali";
  /** Wrap a command for the Kali target (chroot prefix in chroot mode, identity in ssh). */
  wrapKali: (cmd: string) => string;
};

// Module-level persistence — survives tab unmounts so both shells stay alive
// when the operator pops out to Live / MCP / Settings and back.
const persistent: {
  kaliSession: string | null;
  localSession: string | null;
  target: Target;
  nodeId: string | null;
} = { kaliSession: null, localSession: null, target: "kali", nodeId: null };

/**
 * PTY invocation for the Kali target. SSH mode returns "" — the ChannelShell
 * IS a real login PTY, so we open a bare shell. Chroot mode wraps a login
 * zsh (fallback bash) in util-linux `script` for a real TTY inside the chroot.
 */
function kaliInvocation(backendKind: "chroot" | "ssh"): string {
  if (backendKind === "ssh") return "";
  return `SHELL=/bin/zsh HOME=/root TERM=xterm-256color COLORTERM=truecolor FORCE_COLOR=1 PYTHONUNBUFFERED=1 script -qfc 'zsh -l || bash -l' /dev/null`;
}

/**
 * PTY invocation for the local Android host (root via su). No util-linux
 * `script` is guaranteed on the host, so best-effort: use it if present,
 * else drop straight into `sh -l`.
 */
function localInvocation(): string {
  return `TERM=xterm-256color HOME=/data/local/tmp script -qfc 'sh -l' /dev/null 2>/dev/null || sh -l`;
}

export default function TerminalShell({ backendKind, execMode, wrapKali }: Props) {
  const [target, setTarget] = useState<Target>(persistent.target);
  const [kaliSession, setKaliSession] = useState<string | null>(persistent.kaliSession);
  const [localSession, setLocalSession] = useState<string | null>(persistent.localSession);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(persistent.nodeId);
  const [nodePickerOpen, setNodePickerOpen] = useState(false);
  const [nodes, setNodes] = useState<MCPNode[]>([]);
  const [, force] = useState(0);

  // Re-render on every session-manager notify so the status pill stays current.
  useEffect(() => sessionManager.subscribe(() => force((n) => n + 1)), []);

  // ─── Online roster nodes (green = last_health_status "running") ──────────
  const refreshNodes = useCallback(async () => {
    try {
      const all = await nodesLocal.list();
      setNodes(all.filter((n) => n.enabled && n.last_health_status === "running"));
    } catch { /* sqlite unavailable in preview */ }
  }, []);
  useEffect(() => {
    refreshNodes();
    const t = setInterval(refreshNodes, 5000);
    return () => clearInterval(t);
  }, [refreshNodes]);

  // ─── Session resolution ─────────────────────────────────────────────────
  const kaliState: SessionState | null = kaliSession ? sessionManager.sessions.get(kaliSession) || null : null;
  const localState: SessionState | null = localSession ? sessionManager.sessions.get(localSession) || null : null;
  const focusedId = target === "local" ? localSession : kaliSession;
  const focused: SessionState | null = target === "local" ? localState : kaliState;
  const running = !!focused && (focused.status === "running" || focused.status === "starting");
  const selectedNode = selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) || null : null;

  // Persist target on change so a tab flip restores the same view.
  useEffect(() => { persistent.target = target; }, [target]);

  const isAlive = (s: SessionState | null) =>
    !!s && (s.status === "running" || s.status === "starting");

  // ─── Start a target's shell (returns session id, or null on gate fail) ───
  const startKali = useCallback(async (): Promise<string | null> => {
    if (backendKind === "ssh") {
      if (!HAS_NATIVE_SSH) {
        Alert.alert("Native build required", "SSH backend needs the native APK build.");
        return null;
      }
    } else {
      if (!HAS_NATIVE_ROOT || !hasNativeStreaming()) {
        Alert.alert("Native build required", "Persistent shell needs the native streaming bridge — build the APK and run on device.");
        return null;
      }
      if (execMode === "mock") {
        Alert.alert("Preview mode", "Switch to ANDROID or KALI in Settings → execution mode, or enable the SSH backend.");
        return null;
      }
    }
    try {
      const id = await sessionManager.start({
        command: wrapKali(kaliInvocation(backendKind)),
        label: "kali",
        owner: "kali",
        backend: backendKind,
      });
      persistent.kaliSession = id;
      setKaliSession(id);
      return id;
    } catch (e: any) {
      Alert.alert("Failed to start Kali shell", e?.message || "Unknown error");
      return null;
    }
  }, [backendKind, execMode, wrapKali]);

  const startLocal = useCallback(async (): Promise<string | null> => {
    if (!HAS_NATIVE_ROOT || !hasNativeStreaming()) {
      Alert.alert("Root required", "The local host shell needs a rooted device (su). Not available on this device.");
      return null;
    }
    try {
      const id = await sessionManager.start({
        command: localInvocation(),
        label: "local",
        owner: "kali",
        backend: "chroot",
      });
      persistent.localSession = id;
      setLocalSession(id);
      return id;
    } catch (e: any) {
      Alert.alert("Failed to start host shell", e?.message || "Unknown error");
      return null;
    }
  }, []);

  // ─── Target switching (auto-opens the target's shell if not alive) ───────
  const focusKali = useCallback(async () => {
    setSelectedNodeId(null);
    persistent.nodeId = null;
    setTarget("kali");
    if (!isAlive(kaliState)) await startKali();
  }, [kaliState, startKali]);

  const focusLocal = useCallback(async () => {
    setTarget("local");
    if (!isAlive(localState)) await startLocal();
  }, [localState, startLocal]);

  // ─── Node jump — ssh into a roster node from the live Kali shell ─────────
  const jumpToNode = useCallback(async (node: MCPNode) => {
    setNodePickerOpen(false);
    setTarget("kali");
    let id = kaliSession;
    const fresh = !isAlive(kaliState);
    if (fresh) {
      id = await startKali();
      if (!id) return;
    }
    setSelectedNodeId(node.id);
    persistent.nodeId = node.id;
    const user = node.ssh_user || "root";
    const portArg = node.ssh_port && node.ssh_port !== 22 ? ` -p ${node.ssh_port}` : "";
    const cmd = `ssh ${user}@${node.host}${portArg}`;
    // If we just spawned the shell, give the PTY a moment to reach its prompt.
    const inject = () => writeStdin(id!, cmd, true).catch(() => {});
    if (fresh) setTimeout(inject, 900);
    else inject();
  }, [kaliSession, kaliState, startKali]);

  // ─── Bottom action buttons ───────────────────────────────────────────────
  const handleClear = useCallback(() => {
    if (!focusedId) return;
    writeStdin(focusedId, "\x0c", false).catch(() => {}); // Ctrl-L
  }, [focusedId]);

  const handleCopy = useCallback(async () => {
    if (!focusedId) return;
    const s = sessionManager.sessions.get(focusedId);
    if (!s || s.lines.length === 0) { Alert.alert("Nothing to copy", "Session buffer is empty."); return; }
    const text = s.lines.map((l) => l.line).join("\n");
    try {
      await Clipboard.setStringAsync(text);
      Alert.alert("Copied", `${s.lines.length} lines (${text.length} chars) on clipboard.`);
    } catch (e: any) { Alert.alert("Copy failed", e?.message || "Unknown error"); }
  }, [focusedId]);

  const handlePaste = useCallback(async () => {
    if (!focusedId) return;
    try {
      const text = await Clipboard.getStringAsync();
      if (!text) { Alert.alert("Clipboard empty", "Nothing to paste."); return; }
      await writeStdin(focusedId, text, false); // no auto-newline — let the user hit enter
    } catch (e: any) { Alert.alert("Paste failed", e?.message || "Unknown error"); }
  }, [focusedId]);

  const handleClose = useCallback(() => {
    if (!focusedId) return;
    const id = focusedId;
    const isLocal = target === "local";
    Alert.alert(
      `Close ${isLocal ? "host" : "Kali"} shell?`,
      "Send EOF and kill the session?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "EOF (graceful)",
          onPress: async () => {
            await writeStdin(id, "exit", true).catch(() => {});
            setTimeout(() => sessionManager.kill(id, true).catch(() => {}), 400);
          },
        },
        { text: "SIGKILL", style: "destructive", onPress: () => sessionManager.kill(id, false).catch(() => {}) },
      ],
    );
  }, [focusedId, target]);

  // ─── xterm input + keyboard accessory strip ──────────────────────────────
  const handleXTermInput = useCallback((data: string) => {
    if (!focusedId) return;
    writeStdin(focusedId, data, false).catch(() => {});
  }, [focusedId]);

  const sendKey = useCallback((seq: string) => {
    if (!focusedId) return;
    writeStdin(focusedId, seq, false).catch(() => {});
  }, [focusedId]);

  const QUICK_KEYS: { label: string; seq: string; color?: string }[] = [
    { label: "esc", seq: "\x1b" },
    { label: "tab", seq: "\t" },
    { label: "^C", seq: "\x03", color: C.red },
    { label: "^D", seq: "\x04", color: C.red },
    { label: "^Z", seq: "\x1a", color: C.red },
    { label: "|", seq: "|" },
    { label: "~", seq: "~" },
    { label: "/", seq: "/" },
    { label: "-", seq: "-" },
    { label: "↑", seq: "\x1b[A", color: C.cyan },
    { label: "↓", seq: "\x1b[B", color: C.cyan },
    { label: "←", seq: "\x1b[D", color: C.cyan },
    { label: "→", seq: "\x1b[C", color: C.cyan },
  ];

  // ─── Auto-clean expired session ids from persistent state ─────────────────
  useEffect(() => {
    if (kaliSession && !kaliState) { persistent.kaliSession = null; setKaliSession(null); }
  }, [kaliSession, kaliState]);
  useEffect(() => {
    if (localSession && !localState) { persistent.localSession = null; setLocalSession(null); }
  }, [localSession, localState]);

  // ─── Selector pill ────────────────────────────────────────────────────────
  const statusColor = (s: SessionState | null) =>
    !s ? C.textDim
    : s.status === "running" ? C.green
    : s.status === "starting" ? C.yellow
    : s.status === "ended" ? C.textDim
    : C.red;

  const kaliActive = target === "kali" && !selectedNode;
  const nodeActive = target === "kali" && !!selectedNode;
  const localActive = target === "local";

  return (
    <View style={s.root}>
      {/* Target selector — [ kali ] [ node ▼ ] [ local ] */}
      <View style={s.selectorBar}>
        <TouchableOpacity
          testID="term-target-kali"
          onPress={focusKali}
          style={[s.pill, kaliActive && s.pillActive]}
          activeOpacity={0.8}
        >
          <View style={[s.dot, { backgroundColor: statusColor(kaliState) }]} />
          <MaterialCommunityIcons name="linux" size={14} color={kaliActive ? C.green : C.textDim} />
          <Text style={[s.pillText, kaliActive && s.pillTextActive]}>kali</Text>
        </TouchableOpacity>

        <TouchableOpacity
          testID="term-target-node"
          onPress={() => setNodePickerOpen(true)}
          style={[s.pill, nodeActive && s.pillActive]}
          activeOpacity={0.8}
        >
          <MaterialCommunityIcons name="server-network" size={14} color={nodeActive ? C.green : C.textDim} />
          <Text style={[s.pillText, nodeActive && s.pillTextActive]} numberOfLines={1}>
            {selectedNode ? selectedNode.name : "node"}
          </Text>
          <MaterialCommunityIcons name="chevron-down" size={14} color={nodeActive ? C.green : C.textDim} />
        </TouchableOpacity>

        <TouchableOpacity
          testID="term-target-local"
          onPress={focusLocal}
          style={[s.pill, localActive && s.pillActive]}
          activeOpacity={0.8}
        >
          <View style={[s.dot, { backgroundColor: statusColor(localState) }]} />
          <MaterialCommunityIcons name="cellphone" size={14} color={localActive ? C.green : C.textDim} />
          <Text style={[s.pillText, localActive && s.pillTextActive]}>local</Text>
        </TouchableOpacity>
      </View>

      {/* Keyboard accessory strip — only while the focused PTY is live */}
      {running && (
        <View style={s.keyStrip}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always"
            contentContainerStyle={{ paddingHorizontal: 8, gap: 6, alignItems: "center" }}>
            {QUICK_KEYS.map((k) => (
              <TouchableOpacity key={k.label} testID={`termkey-${k.label}`} onPress={() => sendKey(k.seq)} style={s.keyBtn} activeOpacity={0.7}>
                <Text style={[s.keyBtnText, k.color && { color: k.color }]}>{k.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* xterm transcript / idle */}
      {focused ? (
        <View style={{ flex: 1 }}>
          <XTermView key={focusedId || "idle"} sessionId={focusedId} onInput={handleXTermInput} resetToken={focusedId || ""} />
        </View>
      ) : (
        <View style={s.idle}>
          <MaterialCommunityIcons name="console-line" size={40} color={C.textDim} />
          <Text style={s.idleText}>
            {`// ${target} shell\n`}
            tap <Text style={{ color: C.green }}>{target.toUpperCase()}</Text> above to spawn a persistent PTY
          </Text>
          {target === "kali" && backendKind === "chroot" && execMode === "mock" && (
            <Text style={s.idleHint}>⚠ MOCK mode — switch to REAL/KALI or enable the SSH backend first</Text>
          )}
        </View>
      )}

      {/* Bottom action row — CLEAR · COPY · PASTE · CLOSE */}
      <View style={s.actionBar}>
        <ActionBtn testID="btn-term-clear" icon="broom" label="clear" color={C.textDim} disabled={!running} onPress={handleClear} />
        <ActionBtn testID="btn-term-copy" icon="content-copy" label="copy" color={C.cyan} disabled={!focused || focused.lines.length === 0} onPress={handleCopy} />
        <ActionBtn testID="btn-term-paste" icon="content-paste" label="paste" color={C.cyan} disabled={!running} onPress={handlePaste} />
        <ActionBtn testID="btn-term-close" icon="close-circle-outline" label="close" color={C.red} disabled={!running} onPress={handleClose} />
      </View>

      {/* Node picker — online roster nodes only */}
      <Modal visible={nodePickerOpen} transparent animationType="none" onRequestClose={() => setNodePickerOpen(false)}>
        <Pressable style={s.modalBackdrop} onPress={() => setNodePickerOpen(false)}>
          <Pressable style={s.modalSheet} onPress={(e) => e.stopPropagation()}>
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>{"// ssh into node"}</Text>
              <TouchableOpacity onPress={() => { refreshNodes(); }} style={s.refreshBtn}>
                <MaterialCommunityIcons name="refresh" size={16} color={C.cyan} />
              </TouchableOpacity>
            </View>
            <Text style={s.modalHint}>online nodes · jumps from the kali shell</Text>
            {nodes.length === 0 ? (
              <Text style={s.modalEmpty}>no online nodes in roster{"\n"}(green nodes only — check the MCP tab)</Text>
            ) : (
              <ScrollView style={{ maxHeight: 320 }}>
                {nodes.map((n) => (
                  <TouchableOpacity
                    key={n.id}
                    testID={`term-node-${n.id}`}
                    style={[s.nodeRow, selectedNodeId === n.id && s.nodeRowActive]}
                    onPress={() => jumpToNode(n)}
                    activeOpacity={0.8}
                  >
                    <View style={[s.dot, { backgroundColor: C.green }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={s.nodeName}>{n.name}</Text>
                      <Text style={s.nodeMeta}>{n.ssh_user || "root"}@{n.host}{n.ssh_port && n.ssh_port !== 22 ? `:${n.ssh_port}` : ""}</Text>
                    </View>
                    <MaterialCommunityIcons name="login" size={16} color={C.green} />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
            <TouchableOpacity onPress={() => setNodePickerOpen(false)} style={s.modalClose}>
              <Text style={s.modalCloseText}>close</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function ActionBtn({ testID, icon, label, color, disabled, onPress }: {
  testID: string; icon: any; label: string; color: string; disabled: boolean; onPress: () => void;
}) {
  return (
    <TouchableOpacity testID={testID} onPress={onPress} disabled={disabled} activeOpacity={0.7}
      style={[s.actionBtn, disabled && { opacity: 0.35 }]}>
      <MaterialCommunityIcons name={icon} size={16} color={color} />
      <Text style={[s.actionBtnText, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  selectorBar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 10, paddingVertical: 8,
    backgroundColor: C.panel, borderBottomWidth: 1, borderBottomColor: C.border,
  },
  pill: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5,
    paddingHorizontal: 8, paddingVertical: 9,
    borderRadius: 5, borderWidth: 1, borderColor: C.border, backgroundColor: C.panel2,
  },
  pillActive: { borderColor: C.green, backgroundColor: "#0a2010" },
  pillText: { fontFamily: MONO, fontSize: 12, color: C.textDim, includeFontPadding: false },
  pillTextActive: { color: C.green, fontWeight: "700" },
  dot: { width: 7, height: 7, borderRadius: 4 },
  keyStrip: { backgroundColor: C.panel2, borderBottomWidth: 1, borderBottomColor: C.border, paddingVertical: 6 },
  keyBtn: {
    minWidth: 40, alignItems: "center", justifyContent: "center",
    paddingHorizontal: 10, paddingVertical: 7,
    borderRadius: 4, borderWidth: 1, borderColor: C.border, backgroundColor: C.panel,
  },
  keyBtnText: { fontFamily: MONO, fontSize: 13, color: C.text, fontWeight: "700" },
  idle: { flex: 1, alignItems: "center", justifyContent: "center", padding: 30 },
  idleText: { color: C.text, fontFamily: MONO, fontSize: 12, textAlign: "center", marginTop: 12, lineHeight: 18 },
  idleHint: { color: C.yellow, fontFamily: MONO, fontSize: 11, marginTop: 18, textAlign: "center" },
  actionBar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 10, paddingVertical: 8,
    backgroundColor: C.panel, borderTopWidth: 1, borderTopColor: C.border,
  },
  actionBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5,
    paddingVertical: 10, borderRadius: 5, borderWidth: 1, borderColor: C.border, backgroundColor: C.panel2,
  },
  actionBtnText: { fontFamily: MONO, fontSize: 12, fontWeight: "700", includeFontPadding: false },
  // node picker modal
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  modalSheet: {
    backgroundColor: C.panel, borderTopLeftRadius: 12, borderTopRightRadius: 12,
    borderTopWidth: 1, borderColor: C.border, padding: 16, paddingBottom: 28,
  },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  modalTitle: { color: C.green, fontFamily: MONO, fontSize: 14, fontWeight: "700" },
  refreshBtn: { padding: 6 },
  modalHint: { color: C.textDim, fontFamily: MONO, fontSize: 11, marginTop: 2, marginBottom: 12 },
  modalEmpty: { color: C.textDim, fontFamily: MONO, fontSize: 12, textAlign: "center", paddingVertical: 26, lineHeight: 18 },
  nodeRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 11, paddingHorizontal: 10, marginBottom: 6,
    borderRadius: 6, borderWidth: 1, borderColor: C.border, backgroundColor: C.panel2,
  },
  nodeRowActive: { borderColor: C.green },
  nodeName: { color: C.text, fontFamily: MONO, fontSize: 13, fontWeight: "700" },
  nodeMeta: { color: C.textDim, fontFamily: MONO, fontSize: 11, marginTop: 1 },
  modalClose: { marginTop: 12, alignItems: "center", paddingVertical: 10, borderRadius: 6, borderWidth: 1, borderColor: C.border },
  modalCloseText: { color: C.textDim, fontFamily: MONO, fontSize: 12 },
});
