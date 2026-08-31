/* eslint-disable react/jsx-no-comment-textnodes */
// `// section` headings are intentional UI convention across this project,
// see app/index.tsx for the same disable. They render as visible terminal-
// style label text, not actual JS comments.
/**
 * LiveTab — the capture/attack cockpit.
 *
 * Streams output from long-running tools (airodump-ng, wifite, tcpdump,
 * hcxdumptool, dmesg, …) via SessionManager. Each tool is defined as an
 * AttackProfile in MongoDB rather than hardcoded JS — so the user (or
 * Hermes via MCP later) can add/edit/clone them in Settings.
 *
 * Rendering pipeline per session:
 *   - profile.view_mode === "xterm"  → XTermView (Rich/Textual/curses TUI)
 *   - profile.view_mode === "scrollback" → FlatList (plain line stream)
 *
 * PCAP-over-IP: profiles with `needs_endpoint=true` (e.g. "PCAP → remote")
 * pop an endpoint-picker modal at launch. The selected PcapEndpoint's
 * host+port are substituted into the command_template alongside {iface}.
 *
 * Template placeholders:
 *   {iface}  → primaryIface chosen by user in Quick tab
 *   {host}   → selected endpoint.host
 *   {port}   → selected endpoint.port
 *   {file}   → auto-generated /sdcard/cap_<unix_ms> path (no extension —
 *              templates add their own, e.g. {file}.pcapng)
 */
import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  View, Text, StyleSheet, ScrollView, FlatList, TouchableOpacity, TextInput, Alert,
  Platform, Modal,
} from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { sessionManager, SessionState } from "../lib/sessionManager";
import { hasNativeStreaming, RootShell, HAS_NATIVE_ROOT } from "../lib/rootShell";
import { attackProfilesLocal, pcapEndpointsLocal } from "../lib/localDb";
import { cleanAnsi } from "../lib/ansiUtils";
import XTermView from "./XTermView";

const C = {
  bg: "#04070a", panel: "#0a1116", panel2: "#0e1820", border: "#163041",
  green: "#00ff66", greenDim: "#0a8a3a", cyan: "#3ad7ff", red: "#ff3860",
  yellow: "#ffd400", magenta: "#ff5cdb", text: "#cfeadb", textDim: "#6c8a82",
  // Category accents — used to color category chip filters in the drawer.
  // Keep psychologically appropriate: recon=cyan (passive obs), attack=red
  // (active offense), trace=yellow (diagnostic), pcap=magenta (network ops).
  catRecon: "#3ad7ff",
  catAttack: "#ff3860",
  catTrace: "#ffd400",
  catPcap: "#ff5cdb",
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
  /** Resolved API base (already includes /api). Passed from the App-level
   *  shell so we don't duplicate process.env reads down here. */
  apiBase: string;
};

// ─── Server types ─────────────────────────────────────────────────────────
type AttackProfile = {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: "recon" | "attack" | "trace" | "pcap";
  command_template: string;
  needs_iface: boolean;
  needs_endpoint: boolean;
  needs_file: boolean;
  view_mode: "xterm" | "scrollback";
  builtin: boolean;
  sort_order: number;
};

type PcapEndpoint = {
  id: string;
  name: string;
  host: string;
  port: number;
  transport: "tcp" | "udp";
  notes: string;
};

const CAT_COLOR: Record<AttackProfile["category"], string> = {
  recon: C.catRecon,
  attack: C.catAttack,
  trace: C.catTrace,
  pcap: C.catPcap,
};

/**
 * Substitute {iface}, {host}, {port}, {file} placeholders in a command_template.
 * Anything we don't have a substitution for is left as-is (so a typo'd
 * placeholder like {bssid} surfaces visibly in the rendered command,
 * making the misconfiguration obvious instead of silently mangled).
 */
function resolveTemplate(
  template: string,
  ctx: { iface?: string; host?: string; port?: number; file?: string },
): string {
  return template
    .replace(/\{iface\}/g, ctx.iface ?? "{iface}")
    .replace(/\{host\}/g, ctx.host ?? "{host}")
    .replace(/\{port\}/g, ctx.port !== undefined ? String(ctx.port) : "{port}")
    .replace(/\{file\}/g, ctx.file ?? "{file}");
}

export default function LiveTab(props: Props) {
  const [, force] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [customCmd, setCustomCmd] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [presetOpen, setPresetOpen] = useState(false);
  const [probeResult, setProbeResult] = useState<string>("");
  const outRef = useRef<FlatList | null>(null);

  // ─── Attack profiles (fetched from API, replaces hardcoded PRESETS) ────
  const [attackProfiles, setAttackProfiles] = useState<AttackProfile[]>([]);
  const [pcapEndpoints, setPcapEndpoints] = useState<PcapEndpoint[]>([]);
  // category filter — null = show all
  const [catFilter, setCatFilter] = useState<AttackProfile["category"] | null>(null);

  // ─── Endpoint picker modal state ───────────────────────────────────────
  // When a profile with `needs_endpoint=true` is tapped, we open this modal
  // to let the user pick which PcapEndpoint to stream into. The profile is
  // stashed in `pendingProfile` so the user can cancel without losing it.
  const [endpointPickerOpen, setEndpointPickerOpen] = useState(false);
  const [pendingProfile, setPendingProfile] = useState<AttackProfile | null>(null);

  // ─── Inline "quick-add endpoint" form (inside the picker modal) ────────
  // Lets the operator add a PCAP endpoint without leaving the Live tab and
  // digging through Settings → General. Toggled open by the "+ add" button
  // in the picker; on save we persist via pcapEndpointsLocal, refresh the
  // list, and collapse back to the picker with the new endpoint selectable.
  const [epAddOpen, setEpAddOpen] = useState(false);
  const [epAddName, setEpAddName] = useState("");
  const [epAddHost, setEpAddHost] = useState("");
  const [epAddPort, setEpAddPort] = useState("");
  const [epAddTransport, setEpAddTransport] = useState<"tcp" | "udp">("tcp");
  const [epAddSaving, setEpAddSaving] = useState(false);

  const resetEpAddForm = useCallback(() => {
    setEpAddOpen(false);
    setEpAddName(""); setEpAddHost(""); setEpAddPort("");
    setEpAddTransport("tcp");
  }, []);

  // ─── Map sessionId → view_mode ──────────────────────────────────────────
  // Sessions only carry a label, not the originating profile's view_mode.
  // We track it locally so the output renderer can pick xterm vs scrollback
  // for the currently-selected session. Map (not useState) because we
  // mutate it imperatively at session start time + want fresh reads.
  const sessionViewModeRef = useRef<Map<string, "xterm" | "scrollback">>(new Map());

  const fetchAttackProfiles = useCallback(async () => {
    try {
      const data = await attackProfilesLocal.list();
      setAttackProfiles(data as any);
    } catch (e) { console.warn("[LiveTab] attack profiles read failed:", e); }
  }, []);

  const fetchPcapEndpoints = useCallback(async () => {
    try {
      const data = await pcapEndpointsLocal.list();
      setPcapEndpoints(data as any);
    } catch (e) { console.warn("[LiveTab] pcap endpoints read failed:", e); }
  }, []);

  const saveNewEndpoint = useCallback(async () => {
    const name = epAddName.trim();
    const host = epAddHost.trim();
    const port = Number(epAddPort);
    if (!name || !host) {
      Alert.alert("Missing fields", "Name and host are required.");
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      Alert.alert("Bad port", "Port must be between 1 and 65535.");
      return;
    }
    setEpAddSaving(true);
    try {
      await pcapEndpointsLocal.upsert({ name, host, port, transport: epAddTransport });
      await fetchPcapEndpoints();
      resetEpAddForm();
    } catch (e: any) {
      Alert.alert("Save failed", e?.message || "sqlite write error");
    } finally {
      setEpAddSaving(false);
    }
  }, [epAddName, epAddHost, epAddPort, epAddTransport, fetchPcapEndpoints, resetEpAddForm]);

  useEffect(() => { fetchAttackProfiles(); fetchPcapEndpoints(); },
    [fetchAttackProfiles, fetchPcapEndpoints]);

  // Re-fetch endpoints whenever the drawer is opened — the user may have
  // added one in Settings between Live-tab visits.
  useEffect(() => { if (presetOpen) fetchPcapEndpoints(); }, [presetOpen, fetchPcapEndpoints]);

  // ─── Bridge diagnostic probe (debugging "stuck in mock" symptoms) ───────
  const probeMethod = useCallback(async (name: string) => {
    if (!RootShell) { setProbeResult("no native module"); return; }
    const m = (RootShell as any)[name];
    if (typeof m !== "function") {
      setProbeResult(`${name}: NOT REGISTERED (typeof=${typeof m})`);
      return;
    }
    try {
      let result: any;
      if (name === "isRoot") result = await m.call(RootShell);
      else if (name === "exec") result = await m.call(RootShell, "id");
      else if (name === "execBatch") result = await m.call(RootShell, ["id"]);
      else if (name === "executeStream") result = await m.call(RootShell, `probe_${Date.now()}`, "id");
      else if (name === "killSession") result = await m.call(RootShell, "nonexistent", true);
      else if (name === "listSessions") result = await m.call(RootShell);
      else if (name === "addListener") { m.call(RootShell, "RootShell.line"); result = "ok (no return)"; }
      else if (name === "removeListeners") { m.call(RootShell, 1); result = "ok (no return)"; }
      const txt = typeof result === "object" ? JSON.stringify(result).slice(0, 200) : String(result);
      setProbeResult(`${name} OK → ${txt}`);
    } catch (e: any) {
      setProbeResult(`${name} THREW → ${e?.message || String(e)}`);
    }
  }, []);

  useEffect(() => sessionManager.subscribe(() => force((n) => n + 1)), []);
  // Full isolation: Live view only ever shows sessions IT spawned. The Kali
  // terminal (owner:"kali") and AI agent (owner:"ai") sessions are excluded
  // so their output never bleeds into this tab.
  const sessions = sessionManager.list().filter((s) => s.owner === "live");

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

  // The renderer needs to know which mode to use for the *currently
  // selected* session. Default to scrollback for legacy sessions whose
  // profile we don't know (e.g. spawned before we tracked viewMode).
  const selectedViewMode: "xterm" | "scrollback" = useMemo(() => {
    if (!selected) return "scrollback";
    return sessionViewModeRef.current.get(selected.id) || "scrollback";
  }, [selected]);

  useEffect(() => {
    if (!autoScroll || !selected) return;
    if (selectedViewMode === "xterm") return;  // xterm auto-scrolls itself
    const t = setTimeout(() => outRef.current?.scrollToEnd({ animated: false }), 30);
    return () => clearTimeout(t);
  }, [selected?.lines.length, selected?.status, autoScroll, selectedViewMode, selected]);

  // ─── Start a session ────────────────────────────────────────────────────
  // Centralized so both attack-profile launches and the custom command box
  // funnel through here. `viewMode` is recorded so the renderer picks the
  // right component when this session becomes selected.
  const startSession = useCallback(async (
    cmd: string,
    opts: { label?: string; viewMode?: "xterm" | "scrollback"; iface?: string } = {},
  ) => {
    if (!cmd.trim()) return;
    const ifaceForCmd = opts.iface || props.primaryIface;
    const wrapped = props.wrap(cmd);
    const id = await sessionManager.start({
      command: wrapped,
      iface: ifaceForCmd,
      label: opts.label || cmd.split(/\s+/)[0],
      owner: "live",
      forceMock: props.execMode === "mock",
    });
    sessionViewModeRef.current.set(id, opts.viewMode || "scrollback");
    setSelectedId(id);
    setCustomCmd("");
    setPresetOpen(false);
  }, [props.primaryIface, props.wrap, props.execMode]);

  // ─── Launch an AttackProfile ────────────────────────────────────────────
  // 1. If needs_endpoint → open endpoint picker (modal), stash profile.
  // 2. Otherwise substitute placeholders + launch immediately.
  const launchAttackProfile = useCallback((p: AttackProfile, endpoint?: PcapEndpoint) => {
    if (p.needs_endpoint && !endpoint) {
      if (pcapEndpoints.length === 0) {
        Alert.alert(
          "No PCAP endpoints configured",
          "Add one in Settings → General → // pcap endpoints first.",
        );
        return;
      }
      setPendingProfile(p);
      setEndpointPickerOpen(true);
      return;
    }
    const iface = p.needs_iface ? props.primaryIface : undefined;
    const file = p.needs_file ? `/sdcard/cap_${Date.now()}` : undefined;
    const cmd = resolveTemplate(p.command_template, {
      iface,
      host: endpoint?.host,
      port: endpoint?.port,
      file,
    });
    startSession(cmd, {
      label: p.name.replace(/\s+→\s+/g, "→"),  // keep label short for chips
      viewMode: p.view_mode,
      iface,
    });
  }, [pcapEndpoints, props.primaryIface, startSession]);

  // Endpoint picker confirm
  const confirmEndpoint = useCallback((ep: PcapEndpoint) => {
    const p = pendingProfile;
    setEndpointPickerOpen(false);
    setPendingProfile(null);
    if (p) launchAttackProfile(p, ep);
  }, [pendingProfile, launchAttackProfile]);

  const onStop = (s: SessionState) => sessionManager.kill(s.id, true);
  const onForceKill = (s: SessionState) =>
    Alert.alert("Force kill?", `SIGKILL ${s.label} (PID ${s.pid || "?"})\nFiles may not be flushed.`, [
      { text: "Cancel" },
      { text: "SIGKILL", style: "destructive", onPress: () => sessionManager.kill(s.id, false) },
    ]);
  const onRemove = (s: SessionState) => {
    sessionViewModeRef.current.delete(s.id);
    sessionManager.remove(s.id);
  };

  const statusColor = (st: SessionState["status"]) =>
    st === "running" ? C.green :
    st === "starting" ? C.yellow :
    st === "ended" ? C.greenDim :
    st === "killed" ? C.magenta :
    C.red;

  // Filtered + grouped profile list for the drawer.
  const visibleProfiles = useMemo(
    () => catFilter ? attackProfiles.filter((p) => p.category === catFilter) : attackProfiles,
    [attackProfiles, catFilter],
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {/* Persistent bridge diagnostic — debugging "stuck in mock" symptoms */}
      <View style={s.bridgeBar}>
        {(() => {
          const ALL_METHODS = [
            "isRoot", "exec", "execBatch",
            "executeStream", "killSession", "listSessions",
            "addListener", "removeListeners",
          ];
          const hasMod = !!RootShell;
          const keys = hasMod ? Object.keys(RootShell as any) : [];
          const ok = hasNativeStreaming();
          const modeOk = props.execMode !== "mock";
          const methodStatus = ALL_METHODS.map((m) => {
            const t = hasMod ? typeof (RootShell as any)[m] : "no-mod";
            return { name: m, type: t, ok: t === "function" };
          });
          return (
            <>
              <Text style={[s.bridgeText, { color: ok && modeOk ? C.greenDim : C.yellow }]}>
                <Text style={{ color: C.textDim }}>bridge </Text>
                root=<Text style={{ color: HAS_NATIVE_ROOT ? C.green : C.red }}>{HAS_NATIVE_ROOT ? "✓" : "✗"}</Text>{" · "}
                stream=<Text style={{ color: ok ? C.green : C.red }}>{ok ? "✓" : "✗"}</Text>{" · "}
                mode=<Text style={{ color: modeOk ? C.green : C.yellow }}>{props.execMode}</Text>{" · "}
                keys={keys.length}
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 4 }}>
                {methodStatus.map((m) => (
                  <TouchableOpacity
                    key={m.name}
                    onPress={() => probeMethod(m.name)}
                    style={{
                      paddingHorizontal: 5, paddingVertical: 2, marginRight: 4, marginBottom: 3,
                      borderRadius: 2, borderWidth: 1,
                      borderColor: m.ok ? C.greenDim : C.red,
                      backgroundColor: m.ok ? "#06140c" : "#1a0808",
                    }}
                  >
                    <Text style={{
                      fontFamily: MONO, fontSize: 8,
                      color: m.ok ? C.green : C.red,
                    }}>
                      {m.name}={m.type}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              {probeResult && (
                <Text style={[s.bridgeText, { marginTop: 3, color: C.cyan }]} selectable>
                  → {probeResult}
                </Text>
              )}
            </>
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

      {/* Attack-profile drawer */}
      {presetOpen && (
        <View style={s.presetDrawer}>
          {/* Category filter row */}
          <View style={s.catRow}>
            <TouchableOpacity
              testID="cat-all"
              onPress={() => setCatFilter(null)}
              style={[s.catChip, !catFilter && { borderColor: C.green, backgroundColor: "#0a1f12" }]}
            >
              <Text style={[s.catChipText, !catFilter && { color: C.green }]}>all · {attackProfiles.length}</Text>
            </TouchableOpacity>
            {(["recon", "attack", "trace", "pcap"] as const).map((cat) => {
              const n = attackProfiles.filter((p) => p.category === cat).length;
              if (n === 0) return null;
              const active = catFilter === cat;
              return (
                <TouchableOpacity
                  key={cat}
                  testID={`cat-${cat}`}
                  onPress={() => setCatFilter(active ? null : cat)}
                  style={[
                    s.catChip,
                    { borderColor: CAT_COLOR[cat] + (active ? "" : "55") },
                    active && { backgroundColor: CAT_COLOR[cat] + "22" },
                  ]}
                >
                  <Text style={[s.catChipText, { color: CAT_COLOR[cat] }]}>{cat} · {n}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={s.presetTitle}>// {visibleProfiles.length} profiles · iface={props.primaryIface || "—"}</Text>
          <View style={s.presetGrid}>
            {visibleProfiles.map((p) => (
              <TouchableOpacity
                key={p.id}
                testID={`live-preset-${p.id}`}
                onPress={() => launchAttackProfile(p)}
                style={[s.presetItem, { borderLeftColor: CAT_COLOR[p.category], borderLeftWidth: 3 }]}
              >
                <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 2 }}>
                  <MaterialCommunityIcons name={p.icon as any} size={14} color={CAT_COLOR[p.category]} />
                  <Text style={[s.presetLabel, { marginLeft: 4 }]} numberOfLines={1}>{p.name}</Text>
                  {p.view_mode === "xterm" && (
                    <View style={s.tuiBadge}>
                      <Text style={s.tuiBadgeText}>tui</Text>
                    </View>
                  )}
                </View>
                <Text style={s.presetDesc} numberOfLines={2}>{p.description}</Text>
                {p.needs_endpoint && (
                  <Text style={[s.presetDesc, { color: CAT_COLOR.pcap, marginTop: 2 }]}>↪ pick endpoint</Text>
                )}
              </TouchableOpacity>
            ))}
            {visibleProfiles.length === 0 && (
              <Text style={[s.helper, { padding: 8 }]}>
                no profiles in this category — add some in Settings → AI Agents (TODO: add attack-profile editor in Settings)
              </Text>
            )}
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
                <Text style={{ color: C.textDim }}> · view={selectedViewMode}</Text>
                {selected.exitCode !== undefined ? (
                  <Text style={{ color: selected.exitCode === 0 ? C.greenDim : C.red }}>
                    {" · exit="}{selected.exitCode}
                  </Text>
                ) : null}
              </Text>
            </View>
            <View style={{ flexDirection: "row" }}>
              {selectedViewMode !== "xterm" && (
                <TouchableOpacity
                  testID="btn-auto-scroll"
                  onPress={() => setAutoScroll((v) => !v)}
                  style={[s.headBtn, { borderColor: autoScroll ? C.green : C.border }]}
                >
                  <MaterialCommunityIcons name={autoScroll ? "arrow-down-thin-circle-outline" : "pause"} size={14} color={autoScroll ? C.green : C.textDim} />
                </TouchableOpacity>
              )}
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

          {/* Output: xterm OR FlatList, picked per-session */}
          {selectedViewMode === "xterm" ? (
            <View style={{ flex: 1 }}>
              <XTermView
                key={selected.id}
                sessionId={selected.id}
                // Live tab is one-way for now (no stdin into airodump/wifite via
                // xterm) — but the wiring is there for free. Ignore inputs.
                onInput={() => {}}
                resetToken={selected.id}
              />
            </View>
          ) : selected.lines.length === 0 ? (
            <View style={{ flex: 1, backgroundColor: "#02050a", padding: 10 }}>
              <Text style={s.helper}>(no output yet)</Text>
            </View>
          ) : (
            <FlatList
              ref={outRef}
              style={{ flex: 1, backgroundColor: "#02050a" }}
              contentContainerStyle={{ padding: 10, paddingBottom: 24 }}
              data={selected.lines}
              keyExtractor={(l, i) => `${l.line_no}-${i}`}
              renderItem={({ item: l }) => (
                <Text
                  selectable
                  style={[s.outLine, l.stream === "stderr" && { color: C.red }]}
                >
                  {cleanAnsi(l.line)}
                </Text>
              )}
              onScrollBeginDrag={() => setAutoScroll(false)}
              initialNumToRender={30}
              maxToRenderPerBatch={20}
              windowSize={10}
              removeClippedSubviews={Platform.OS === "android"}
              ListFooterComponent={selected.errorMessage ? (
                <Text style={[s.outLine, { color: C.red, marginTop: 6 }]}>
                  [error] {selected.errorMessage}
                </Text>
              ) : null}
            />
          )}
        </View>
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <MaterialCommunityIcons name="satellite-uplink" size={48} color={C.greenDim} />
          <Text style={[s.helper, { marginTop: 12, textAlign: "center" }]}>
            no active session — tap{" "}
            <Text style={{ color: C.green }}>+</Text> to launch an attack profile
          </Text>
          <Text style={[s.helper, { marginTop: 4, textAlign: "center", color: C.textDim }]}>
            airodump · wifite · tcpdump · hcxdumptool · pcap→remote · …
          </Text>
        </View>
      )}

      {/* ─── Endpoint picker modal (for needs_endpoint profiles) ───────── */}
      <Modal
        visible={endpointPickerOpen}
        animationType="none"
        transparent
        onRequestClose={() => { setEndpointPickerOpen(false); setPendingProfile(null); resetEpAddForm(); }}
      >
        <View style={s.modalBackdrop}>
          <View style={s.modalSheet}>
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>
                // pick endpoint for {pendingProfile?.name || "?"}
              </Text>
              <TouchableOpacity
                onPress={() => { setEndpointPickerOpen(false); setPendingProfile(null); resetEpAddForm(); }}
                testID="btn-ep-close"
              >
                <Ionicons name="close" size={20} color={C.green} />
              </TouchableOpacity>
            </View>
            <Text style={[s.helper, { marginBottom: 8 }]}>
              packets will stream live to the selected endpoint via{" "}
              <Text style={{ color: C.cyan }}>tcpdump | nc</Text>
            </Text>
            <ScrollView style={{ maxHeight: 380 }} keyboardShouldPersistTaps="handled">
              {pcapEndpoints.map((ep) => (
                <TouchableOpacity
                  key={ep.id}
                  testID={`ep-pick-${ep.id}`}
                  onPress={() => confirmEndpoint(ep)}
                  style={s.epRow}
                >
                  <MaterialCommunityIcons name="cloud-upload" size={18} color={C.catPcap} />
                  <View style={{ flex: 1, marginLeft: 10 }}>
                    <Text style={s.epName}>{ep.name}</Text>
                    <Text style={s.epHost}>
                      {ep.transport}://{ep.host}:{ep.port}
                      {ep.notes ? <Text style={{ color: C.textDim }}>  · {ep.notes}</Text> : null}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={C.textDim} />
                </TouchableOpacity>
              ))}
              {pcapEndpoints.length === 0 && !epAddOpen && (
                <Text style={[s.helper, { padding: 16, textAlign: "center" }]}>
                  no endpoints yet — tap &quot;+ add endpoint&quot; below to create one
                </Text>
              )}

              {/* Inline quick-add form — add an endpoint without leaving Live */}
              {epAddOpen ? (
                <View style={s.epAddForm}>
                  <Text style={[s.modalTitle, { fontSize: 11, marginBottom: 8 }]}>// new endpoint</Text>
                  <TextInput
                    testID="input-ep-name"
                    value={epAddName} onChangeText={setEpAddName}
                    placeholder="name (e.g. wireshark-box)" placeholderTextColor={C.textDim}
                    style={s.epInput} autoCapitalize="none" autoCorrect={false}
                  />
                  <TextInput
                    testID="input-ep-host"
                    value={epAddHost} onChangeText={setEpAddHost}
                    placeholder="host / tailnet IP" placeholderTextColor={C.textDim}
                    style={s.epInput} autoCapitalize="none" autoCorrect={false}
                    keyboardType="numbers-and-punctuation"
                  />
                  <TextInput
                    testID="input-ep-port"
                    value={epAddPort} onChangeText={setEpAddPort}
                    placeholder="port (e.g. 19000)" placeholderTextColor={C.textDim}
                    style={s.epInput} keyboardType="number-pad"
                  />
                  <View style={{ flexDirection: "row", marginTop: 6, marginBottom: 4 }}>
                    {(["tcp", "udp"] as const).map((t) => (
                      <TouchableOpacity
                        key={t}
                        testID={`btn-ep-transport-${t}`}
                        onPress={() => setEpAddTransport(t)}
                        style={[
                          s.epTransportChip,
                          epAddTransport === t && { borderColor: C.green, backgroundColor: "#0a1f12" },
                        ]}
                      >
                        <Text style={[s.epHost, epAddTransport === t && { color: C.green }]}>{t}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 8 }}>
                    <TouchableOpacity
                      testID="btn-ep-add-cancel"
                      onPress={resetEpAddForm}
                      style={[s.epActionBtn, { borderColor: C.border, marginRight: 6 }]}
                    >
                      <Text style={[s.epHost, { color: C.textDim }]}>CANCEL</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      testID="btn-ep-add-save"
                      onPress={saveNewEndpoint}
                      disabled={epAddSaving}
                      style={[s.epActionBtn, { borderColor: C.green, opacity: epAddSaving ? 0.5 : 1 }]}
                    >
                      <Ionicons name="save-outline" size={13} color={C.green} />
                      <Text style={[s.epHost, { color: C.green, marginLeft: 4 }]}>
                        {epAddSaving ? "SAVING…" : "SAVE"}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity
                  testID="btn-ep-add-open"
                  onPress={() => setEpAddOpen(true)}
                  style={s.epAddBtn}
                >
                  <Ionicons name="add" size={16} color={C.catPcap} />
                  <Text style={[s.epName, { color: C.catPcap, marginLeft: 6 }]}>add endpoint</Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
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
  presetLabel: { color: C.text, fontFamily: MONO, fontSize: 11, fontWeight: "700", flex: 1 },
  presetDesc: { color: C.textDim, fontFamily: MONO, fontSize: 9 },

  // Category filter chips above the preset grid
  catRow: { flexDirection: "row", flexWrap: "wrap", marginBottom: 8, gap: 4 },
  catChip: {
    paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: 3, borderWidth: 1, borderColor: C.border, backgroundColor: C.panel2,
  },
  catChipText: { fontFamily: MONO, fontSize: 10, color: C.textDim },

  // "tui" mini-badge on profile cards that use xterm view mode
  tuiBadge: {
    paddingHorizontal: 4, paddingVertical: 1, marginLeft: 4,
    backgroundColor: "#1a1428", borderWidth: 1, borderColor: "#b08aff", borderRadius: 2,
  },
  tuiBadgeText: { fontFamily: MONO, fontSize: 7, color: "#b08aff", letterSpacing: 0.5 },

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

  // Endpoint picker modal
  modalBackdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "center", alignItems: "center", padding: 20,
  },
  modalSheet: {
    width: "100%", maxWidth: 480,
    backgroundColor: C.panel, borderWidth: 1, borderColor: C.border,
    borderRadius: 6, padding: 14,
  },
  modalHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    marginBottom: 8, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border,
  },
  modalTitle: { color: C.green, fontFamily: MONO, fontSize: 13, fontWeight: "700", flex: 1 },
  epRow: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 10, paddingHorizontal: 8,
    backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border,
    borderRadius: 4, marginBottom: 6,
  },
  epName: { color: C.text, fontFamily: MONO, fontSize: 12, fontWeight: "700" },
  epHost: { color: C.cyan, fontFamily: MONO, fontSize: 10, marginTop: 2 },
  epAddBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    paddingVertical: 10, marginTop: 4, marginBottom: 4,
    borderWidth: 1, borderColor: C.catPcap, borderStyle: "dashed", borderRadius: 4,
  },
  epAddForm: {
    marginTop: 6, padding: 10,
    backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: 4,
  },
  epInput: {
    color: C.green, fontFamily: MONO, fontSize: 12,
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 4,
    paddingHorizontal: 8, paddingVertical: 8, marginTop: 6,
  },
  epTransportChip: {
    paddingHorizontal: 12, paddingVertical: 5, marginRight: 6,
    borderWidth: 1, borderColor: C.border, borderRadius: 3,
  },
  epActionBtn: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 12, paddingVertical: 6,
    borderWidth: 1, borderRadius: 4,
  },
});
