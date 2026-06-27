/**
 * MCPTab — Phase 1A scaffold for the cockpit's upcoming MCP (Model Context
 * Protocol) server. The actual chroot-side FastMCP process gets wired in
 * Phase 1B; for now this tab is the persistent control surface:
 *
 *   • Server status pill          (stopped until 1B server lands)
 *   • Config card                 (port / bind / bearer token / require-token)
 *   • Tools registry              (list / enable-disable / add custom)
 *   • Audit log                   (placeholder feed — will be populated by
 *                                  the chroot server posting events back via
 *                                  loopback in 1B)
 *
 * Everything reads/writes through `mcpLocal` (SQLite). No network. Cold-boot
 * safe like the rest of the local-first cockpit.
 */
import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  Alert, Platform, Switch,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import {
  mcpLocal,
  type MCPConfig, type MCPTool, type MCPAuditEntry,
} from "../lib/localDb";

// Keep palette identical to the rest of the cockpit so the tab feels native.
const C = {
  bg: "#04070a", panel: "#0a1116", panel2: "#0e1820", border: "#163041",
  green: "#00ff66", greenDim: "#0a8a3a", cyan: "#3ad7ff", red: "#ff3860",
  yellow: "#ffd400", magenta: "#ff5cdb", text: "#cfeadb", textDim: "#6c8a82",
  mcpAccent: "#7df9ff",   // distinct MCP brand color (icy-cyan)
};
const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

// 256-bit URL-safe bearer token, hex-encoded. Crypto-secure via expo-crypto.
async function generateBearerToken(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(32);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function shortToken(t: string): string {
  if (!t) return "(none)";
  if (t.length <= 16) return t;
  return `${t.slice(0, 6)}…${t.slice(-4)}`;
}

function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour12: false }) + "." +
      String(d.getMilliseconds()).padStart(3, "0");
  } catch { return iso; }
}

type SubTab = "status" | "tools" | "audit";

export default function MCPTab() {
  const [subTab, setSubTab] = useState<SubTab>("status");
  const [config, setConfig] = useState<MCPConfig | null>(null);
  const [tools, setTools] = useState<MCPTool[]>([]);
  const [audit, setAudit] = useState<MCPAuditEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [tokenVisible, setTokenVisible] = useState(false);

  // Local form state — committed to SQLite via debounced updateConfig().
  const [portInput, setPortInput] = useState("8765");
  const [bindInput, setBindInput] = useState("127.0.0.1");
  const [probeInput, setProbeInput] = useState("127.0.0.1");

  // Tool editor modal — null = closed, else current draft.
  const [editingTool, setEditingTool] = useState<Partial<MCPTool> | null>(null);

  // ─── Live link to chroot server ───────────────────────────────────────
  // serverHealth = "unknown" (initial / disarmed)
  //              | "probing"
  //              | "running"        (last /health returned 200)
  //              | "unreachable"    (network error / connection refused)
  //              | "auth_failed"    (401/403 from /audit/since — bearer mismatch)
  //              | "error"          (5xx / unexpected shape)
  type Health = "unknown" | "probing" | "running" | "unreachable" | "auth_failed" | "error";
  const [serverHealth, setServerHealth] = useState<Health>("unknown");
  const [serverInfo, setServerInfo] = useState<any>(null);
  const [lastProbeAt, setLastProbeAt] = useState<number | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [auditSyncCount, setAuditSyncCount] = useState(0);
  // Tick every second to refresh "Xs ago" labels without re-firing polls
  const [, setTick] = useState(0);

  const refresh = useCallback(async () => {
    const [c, t, a] = await Promise.all([
      mcpLocal.getConfig(),
      mcpLocal.listTools(),
      mcpLocal.listAudit(200),
    ]);
    setConfig(c);
    setTools(t);
    setAudit(a);
    setPortInput(String(c.port));
    setBindInput(c.bind_host);
    setProbeInput(c.cockpit_probe_host || "127.0.0.1");
  }, []);

  useEffect(() => {
    refresh().catch((e) => console.warn("[MCPTab] refresh failed:", e));
  }, [refresh]);

  // ─── Health probe + audit sync loop ────────────────────────────────────
  // Runs only while the MCP tab is mounted (index.tsx renders us
  // conditionally on tab === "mcp"). When the user leaves the tab the
  // component unmounts, the cleanup fires, and battery thanks us.
  //
  // Cadence:
  //   • Every 5s: GET {probe_host}:{port}/health  → status pill
  //   • Every 3s, only when serverHealth === "running":
  //       GET {probe_host}:{port}/audit/since?ts=<latest local ts>
  //       Bulk-ingest via mcpLocal.syncAuditFromServer() → // audit fills live
  useEffect(() => {
    if (!config) return;
    if (!config.server_enabled) {
      setServerHealth("unknown");
      setServerInfo(null);
      return;
    }
    const probeHost = (config.cockpit_probe_host || "127.0.0.1").trim();
    const port = config.port;
    const token = config.bearer_token;
    const base = `http://${probeHost}:${port}`;
    let cancelled = false;

    const tryFetch = async (path: string, useAuth: boolean): Promise<Response> => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 3500);
      try {
        const headers: Record<string, string> = { Accept: "application/json" };
        if (useAuth && token) headers.Authorization = `Bearer ${token}`;
        return await fetch(`${base}${path}`, { headers, signal: ctl.signal });
      } finally {
        clearTimeout(timer);
      }
    };

    const probeHealth = async () => {
      setServerHealth((prev) => prev === "unknown" ? "probing" : prev);
      try {
        // /health is intentionally public — works even if bearer is empty/wrong
        const r = await tryFetch("/health", false);
        if (cancelled) return;
        if (!r.ok) {
          setServerHealth("error");
          setProbeError(`HTTP ${r.status}`);
          return;
        }
        const info = await r.json();
        if (cancelled) return;
        setServerInfo(info);
        setProbeError(null);
        setLastProbeAt(Date.now());
        setServerHealth("running");
      } catch (e: any) {
        if (cancelled) return;
        const msg = e?.message || String(e);
        // Network-level failure ≠ server bug. AbortError = our 3.5s timeout.
        if (msg.includes("Network") || msg.includes("aborted") ||
            msg.includes("Failed to fetch") || msg.includes("ECONNREFUSED") ||
            msg.includes("connect")) {
          setServerHealth("unreachable");
        } else {
          setServerHealth("error");
        }
        setProbeError(msg);
        setLastProbeAt(Date.now());
      }
    };

    const syncAudit = async () => {
      try {
        const cursor = await mcpLocal.getMaxAuditTs();
        const q = cursor ? `?ts=${encodeURIComponent(cursor)}` : "";
        const r = await tryFetch(`/audit/since${q}`, true);
        if (cancelled) return;
        if (r.status === 401 || r.status === 403) {
          setServerHealth("auth_failed");
          setProbeError(`audit poll ${r.status} — bearer token mismatch with server config.yaml`);
          return;
        }
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled) return;
        const events = (data?.events || []) as any[];
        if (events.length === 0) return;
        const inserted = await mcpLocal.syncAuditFromServer(events);
        if (inserted > 0) {
          setAuditSyncCount((c) => c + inserted);
          // Refresh the visible audit list
          const list = await mcpLocal.listAudit(200);
          if (!cancelled) setAudit(list);
        }
      } catch {
        // Silent — health loop reports connection status; audit just no-ops
      }
    };

    // Fire immediately, then on intervals
    probeHealth();
    const healthTimer = setInterval(probeHealth, 5000);
    const auditTimer = setInterval(() => {
      // Only poll audit when server is confirmed reachable to avoid
      // duplicating "unreachable" noise across two loops.
      setServerHealth((cur) => {
        if (cur === "running") syncAudit();
        return cur;
      });
    }, 3000);
    const tickTimer = setInterval(() => setTick((t) => t + 1), 1000);

    return () => {
      cancelled = true;
      clearInterval(healthTimer);
      clearInterval(auditTimer);
      clearInterval(tickTimer);
    };
  }, [config?.server_enabled, config?.cockpit_probe_host, config?.port, config?.bearer_token]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Config writes ──────────────────────────────────────────────────────
  const patchConfig = useCallback(async (patch: Partial<MCPConfig>) => {
    setBusy(true);
    try {
      const merged = await mcpLocal.updateConfig(patch);
      setConfig(merged);
    } catch (e: any) {
      Alert.alert("MCP config save failed", e?.message || "sqlite error");
    } finally { setBusy(false); }
  }, []);

  const handleToggleServer = useCallback(async (next: boolean) => {
    if (next && (!config?.bearer_token || config.bearer_token.length < 16) && config?.require_token) {
      Alert.alert(
        "Generate a token first",
        "Server is set to require a bearer token but none is set. Generate one before enabling.",
      );
      return;
    }
    // Phase 1B.2a: server IS real now (you scp/git-pull'd it into the
    // chroot and ran it manually). Toggle just controls cockpit-side
    // probing + audit sync. Auto-spawn comes in 1B.2b.
    await patchConfig({ server_enabled: next });
  }, [config, patchConfig]);

  const handleRegenerateToken = useCallback(async () => {
    const token = await generateBearerToken();
    await patchConfig({ bearer_token: token });
    Alert.alert("New bearer token generated", "Copy it now — it's the only way external MCP clients can connect.");
  }, [patchConfig]);

  const handleImportToken = useCallback(async () => {
    try {
      const pasted = (await Clipboard.getStringAsync()).trim();
      // Validate: 64 hex chars (256-bit token from generateBearerToken)
      // or at least 16 chars (allows shorter custom tokens too).
      if (!pasted) {
        Alert.alert("Clipboard empty", "Copy a token first (long-press in any text field → Copy), then tap IMPORT.");
        return;
      }
      if (!/^[0-9a-f]+$/i.test(pasted) || pasted.length < 16) {
        Alert.alert(
          "Doesn't look like a bearer token",
          `Got "${pasted.slice(0, 24)}${pasted.length > 24 ? "…" : ""}" (${pasted.length} chars). Expected hex chars only, ≥16 long.`,
        );
        return;
      }
      Alert.alert(
        "Import this token?",
        `Paste from clipboard:\n${pasted.slice(0, 8)}…${pasted.slice(-4)} (${pasted.length} chars)\n\nThis will REPLACE the current token. Make sure it matches the one in /etc/enforcer-mcp/config.yaml on the chroot server.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Import",
            onPress: async () => {
              await patchConfig({ bearer_token: pasted.toLowerCase() });
              Alert.alert("Token imported", "Cockpit will use this for /audit/since polls. If status pill still shows TOKEN MISMATCH, verify the chroot's config.yaml has the SAME value.");
            },
          },
        ],
      );
    } catch (e: any) {
      Alert.alert("Import failed", e?.message || "clipboard read error");
    }
  }, [patchConfig]);

  const handleCopyToken = useCallback(async () => {
    if (!config?.bearer_token) return;
    await Clipboard.setStringAsync(config.bearer_token);
    Alert.alert("Copied", "Bearer token copied to clipboard.");
  }, [config?.bearer_token]);

  const handleClearAudit = useCallback(() => {
    Alert.alert(
      "Clear audit log?",
      "All MCP tool-call history will be wiped from local SQLite.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear", style: "destructive",
          onPress: async () => {
            await mcpLocal.clearAudit();
            setAudit([]);
          },
        },
      ],
    );
  }, []);

  // ─── Tools CRUD ─────────────────────────────────────────────────────────
  const toggleToolEnabled = useCallback(async (t: MCPTool) => {
    await mcpLocal.upsertTool({ ...t, enabled: !t.enabled });
    refresh();
  }, [refresh]);

  const saveTool = useCallback(async () => {
    if (!editingTool) return;
    if (!editingTool.name?.trim() || !editingTool.command_template?.trim()) {
      Alert.alert("Required", "Name and command template are required.");
      return;
    }
    // JSON-validate the schema string before persisting
    let schemaStr = editingTool.arg_schema_json || "{}";
    try { JSON.parse(schemaStr); } catch (e: any) {
      Alert.alert("Invalid arg schema", `Must be valid JSON: ${e.message}`);
      return;
    }
    try {
      await mcpLocal.upsertTool({
        id: editingTool.id,
        name: editingTool.name.trim(),
        description: editingTool.description || "",
        command_template: editingTool.command_template.trim(),
        arg_schema_json: schemaStr,
        wrap_mode: editingTool.wrap_mode || "auto",
        timeout_sec: editingTool.timeout_sec ?? 60,
        enabled: editingTool.enabled !== false,
        built_in: !!editingTool.built_in,
      });
      setEditingTool(null);
      refresh();
    } catch (e: any) {
      Alert.alert("Save failed", e?.message || "sqlite error");
    }
  }, [editingTool, refresh]);

  const deleteTool = useCallback((t: MCPTool) => {
    if (t.built_in) {
      Alert.alert("Can't delete built-in", "Disable it instead — built-in tools restore on next install.");
      return;
    }
    Alert.alert(
      "Delete tool?",
      `Remove "${t.name}" from the registry?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete", style: "destructive",
          onPress: async () => { await mcpLocal.deleteTool(t.id); refresh(); },
        },
      ],
    );
  }, [refresh]);

  // ─── Computed status ────────────────────────────────────────────────────
  const statusInfo = useMemo(() => {
    if (!config) return { label: "loading", color: C.textDim };
    if (!config.server_enabled) return { label: "DISARMED", color: C.textDim };
    switch (serverHealth) {
      case "running":
        return { label: "RUNNING", color: C.green };
      case "probing":
      case "unknown":
        return { label: "ARMED · PROBING…", color: C.yellow };
      case "unreachable":
        return { label: "ARMED · UNREACHABLE", color: C.yellow };
      case "auth_failed":
        return { label: "ARMED · TOKEN MISMATCH", color: C.red };
      case "error":
        return { label: "ARMED · ERROR", color: C.red };
      default:
        return { label: "ARMED", color: C.yellow };
    }
  }, [config, serverHealth]);

  const probeAgeStr = useMemo(() => {
    if (!lastProbeAt) return "—";
    const dt = Math.max(0, Math.floor((Date.now() - lastProbeAt) / 1000));
    return `${dt}s ago`;
  }, [lastProbeAt]);

  // ─── Render ─────────────────────────────────────────────────────────────
  if (!config) {
    return (
      <View style={[s.container, { justifyContent: "center", alignItems: "center" }]}>
        <Text style={[s.helper, { color: C.textDim }]}>{"// loading mcp config…"}</Text>
      </View>
    );
  }

  return (
    <View style={s.container}>
      {/* SUB-TAB BAR */}
      <View style={s.subTabBar}>
        {(["status", "tools", "audit"] as SubTab[]).map((st) => (
          <TouchableOpacity
            key={st}
            onPress={() => setSubTab(st)}
            style={[s.subTabBtn, subTab === st && s.subTabBtnActive]}
            activeOpacity={0.7}
          >
            <Text style={[s.subTabText, subTab === st && { color: C.mcpAccent }]}>
              {st === "status" ? "// status" : st === "tools" ? `// tools (${tools.length})` : `// audit (${audit.length})`}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* STATUS PANE */}
      {subTab === "status" && (
        <ScrollView contentContainerStyle={{ padding: 14 }}>
          <Text style={s.sectionTitle}>{"// server"}</Text>
          <View style={s.card}>
            <View style={s.row}>
              <View style={[s.statusDot, { backgroundColor: statusInfo.color }]} />
              <Text style={[s.statusText, { color: statusInfo.color }]}>{statusInfo.label}</Text>
            </View>
            <Text style={s.helper}>
              {"Transport: "}<Text style={{ color: C.cyan }}>HTTP + SSE</Text>
            </Text>
            <Text style={[s.helperFine, { marginTop: 4 }]}>
              {"client endpoint (Postman/Hermes use this):"}
            </Text>
            <Text style={[s.helperFine, { marginTop: 2 }]}>
              <Text style={{ color: C.cyan }}>http://{config.bind_host}:{config.port}/mcp</Text>
            </Text>
            <View style={[s.row, { marginTop: 10 }]}>
              <Text style={s.kvLabel}>enable server</Text>
              <Switch
                value={config.server_enabled}
                onValueChange={handleToggleServer}
                trackColor={{ false: C.border, true: C.greenDim }}
                thumbColor={config.server_enabled ? C.green : C.textDim}
                disabled={busy}
              />
            </View>
          </View>

          <Text style={[s.sectionTitle, { marginTop: 20 }]}>{"// network"}</Text>
          <View style={s.card}>
            <Text style={s.kvLabel}>server bind host</Text>
            <TextInput
              style={s.input}
              value={bindInput}
              onChangeText={setBindInput}
              onBlur={() => bindInput !== config.bind_host && patchConfig({ bind_host: bindInput.trim() || "127.0.0.1" })}
              placeholder="127.0.0.1 (loopback) or 0.0.0.0 (LAN/Tailscale)"
              placeholderTextColor={C.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
            />
            <Text style={[s.helperFine, { marginTop: 4 }]}>
              loopback for local-only · 0.0.0.0 for Tailscale mesh · or a specific iface IP
            </Text>

            <Text style={[s.kvLabel, { marginTop: 14 }]}>cockpit probe host</Text>
            <TextInput
              style={s.input}
              value={probeInput}
              onChangeText={setProbeInput}
              onBlur={() => {
                // Strip anything that isn't a bare host. We construct
                // `http://{host}:{port}/...` ourselves, so a paste of
                // `http://s10-nethunter:8765/mcp` should yield just
                // `s10-nethunter`. This prevents the "/mcp got lost between
                // host and port" confusion.
                let v = (probeInput || "").trim();
                v = v.replace(/^https?:\/\//i, "");
                v = v.split("/")[0];   // drop path
                v = v.split(":")[0];   // drop port
                v = v || "127.0.0.1";
                if (v !== probeInput) setProbeInput(v);
                if (v !== config.cockpit_probe_host) patchConfig({ cockpit_probe_host: v });
              }}
              placeholder="127.0.0.1 (default — works for bind 0.0.0.0 or loopback)"
              placeholderTextColor={C.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
            />
            <Text style={[s.helperFine, { marginTop: 4 }]}>
              where THIS cockpit connects to probe /health + /audit. host only — no scheme,
              no port, no path. set to the tailnet IP (e.g. 100.x.y.z) if MagicDNS
              hostnames don&apos;t resolve on Android.
            </Text>

            <Text style={[s.kvLabel, { marginTop: 14 }]}>port</Text>
            <TextInput
              style={s.input}
              value={portInput}
              onChangeText={setPortInput}
              onBlur={() => {
                const n = parseInt(portInput, 10);
                if (Number.isInteger(n) && n >= 1024 && n <= 65535 && n !== config.port) {
                  patchConfig({ port: n });
                } else if (n !== config.port) {
                  setPortInput(String(config.port));
                  Alert.alert("Invalid port", "Use 1024..65535.");
                }
              }}
              placeholder="8765"
              placeholderTextColor={C.textDim}
              keyboardType="number-pad"
            />
          </View>

          {/* LIVE CONNECTIVITY CARD — only meaningful when server_enabled */}
          {config.server_enabled && (
            <>
              <Text style={[s.sectionTitle, { marginTop: 20 }]}>{"// connectivity"}</Text>
              <View style={s.card}>
                <Text style={[s.helperFine]}>
                  {"this cockpit's probe target:"}
                </Text>
                <Text style={[s.helperFine, { marginTop: 2 }]}>
                  <Text style={{ color: C.cyan }}>
                    http://{(config.cockpit_probe_host || "127.0.0.1")}:{config.port}
                  </Text>
                </Text>
                <Text style={[s.helperFine, { marginTop: 6 }]}>
                  last health probe: <Text style={{ color: C.cyan }}>{probeAgeStr}</Text>
                  {"  ·  "}
                  audit events synced this session: <Text style={{ color: C.cyan }}>{auditSyncCount}</Text>
                </Text>
                {serverInfo && (
                  <Text style={[s.helperFine, { marginTop: 4 }]}>
                    server: <Text style={{ color: C.cyan }}>{serverInfo.service}@{serverInfo.version}</Text>
                    {"  ·  "}tools: <Text style={{ color: C.cyan }}>{serverInfo.tools}</Text>
                    {"  ·  "}require_token: <Text style={{ color: serverInfo.require_token ? C.green : C.yellow }}>
                      {String(!!serverInfo.require_token)}
                    </Text>
                  </Text>
                )}
                {probeError && serverHealth !== "running" && (
                  <Text style={[s.helperFine, { marginTop: 6, color: C.red }]}>
                    err: {probeError}
                  </Text>
                )}
              </View>
            </>
          )}

          <Text style={[s.sectionTitle, { marginTop: 20 }]}>{"// auth · bearer token"}</Text>
          <View style={s.card}>
            <View style={[s.row, { justifyContent: "space-between" }]}>
              <Text style={s.kvLabel}>require token</Text>
              <Switch
                value={config.require_token}
                onValueChange={(v) => patchConfig({ require_token: v })}
                trackColor={{ false: C.border, true: C.greenDim }}
                thumbColor={config.require_token ? C.green : C.textDim}
              />
            </View>
            <Text style={[s.helperFine, { marginTop: 6 }]}>
              when off, any client reaching the endpoint can call tools — only
              acceptable if bind_host=127.0.0.1 AND you trust everything on this device.
            </Text>

            <View style={[s.tokenBox, { marginTop: 14 }]}>
              <Text style={s.tokenText} selectable>
                {!config.bearer_token
                  ? "(no token yet — tap REGENERATE)"
                  : tokenVisible ? config.bearer_token : shortToken(config.bearer_token)}
              </Text>
            </View>
            <View style={[s.row, { marginTop: 10, gap: 6 }]}>
              <TouchableOpacity
                style={[s.btn, { flex: 0.9, backgroundColor: C.panel2 }]}
                onPress={() => setTokenVisible((v) => !v)}
              >
                <MaterialCommunityIcons name={tokenVisible ? "eye-off" : "eye"} size={14} color={C.cyan} />
                <Text style={[s.btnText, { color: C.cyan }]}>{tokenVisible ? "HIDE" : "REVEAL"}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.btn, { flex: 0.9, backgroundColor: C.panel2 }]}
                onPress={handleCopyToken}
                disabled={!config.bearer_token}
              >
                <MaterialCommunityIcons name="content-copy" size={14} color={C.green} />
                <Text style={[s.btnText, { color: C.green }]}>COPY</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.btn, { flex: 0.9, backgroundColor: C.panel2, borderColor: C.cyan }]}
                onPress={handleImportToken}
              >
                <MaterialCommunityIcons name="content-paste" size={14} color={C.cyan} />
                <Text style={[s.btnText, { color: C.cyan }]}>IMPORT</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.btn, { flex: 1.1, backgroundColor: C.panel2, borderColor: C.magenta }]}
                onPress={handleRegenerateToken}
              >
                <MaterialCommunityIcons name="key-change" size={14} color={C.magenta} />
                <Text style={[s.btnText, { color: C.magenta }]}>REGEN</Text>
              </TouchableOpacity>
            </View>
            <Text style={[s.helperFine, { marginTop: 10 }]}>
              clients send: <Text style={{ color: C.cyan }}>Authorization: Bearer &lt;token&gt;</Text>
            </Text>
            <Text style={[s.helperFine, { marginTop: 6, color: C.yellow }]}>
              ⚠ token lives in Android Keystore (encrypted) + sqlite cache. survives
              app updates &amp; clear-data, but NOT full uninstall. COPY it somewhere
              safe before reinstalling the APK.
            </Text>
          </View>

          <Text style={[s.sectionTitle, { marginTop: 20 }]}>{"// roadmap"}</Text>
          <View style={s.card}>
            <Text style={s.helper}>
              <Text style={{ color: C.green }}>✓</Text> 1A  · UI + persistence{"\n"}
              <Text style={{ color: C.green }}>✓</Text> 1B.1 · FastMCP server (chroot){"\n"}
              <Text style={{ color: C.green }}>✓</Text> 1B.2a · live probe + audit sync (this build){"\n"}
              <Text style={{ color: C.yellow }}>·</Text> 1B.2b · cockpit auto-spawn the server{"\n"}
              <Text style={{ color: C.textDim }}>·</Text> 1C  · real session handlers (PTY){"\n"}
              <Text style={{ color: C.textDim }}>·</Text> 1D  · local Hermes ↔ local MCP loop{"\n"}
              <Text style={{ color: C.textDim }}>·</Text> 2   · Tailscale bridge + Nodes tab + enforcer-node .deb
            </Text>
          </View>
        </ScrollView>
      )}

      {/* TOOLS PANE */}
      {subTab === "tools" && (
        <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 90 }}>
          <View style={[s.row, { justifyContent: "space-between", marginBottom: 12 }]}>
            <Text style={s.sectionTitle}>{"// registered tools"}</Text>
            <TouchableOpacity
              style={[s.btn, { backgroundColor: C.panel2, borderColor: C.mcpAccent }]}
              onPress={() => setEditingTool({ name: "", command_template: "", wrap_mode: "auto", timeout_sec: 60, enabled: true, built_in: false })}
            >
              <MaterialCommunityIcons name="plus" size={14} color={C.mcpAccent} />
              <Text style={[s.btnText, { color: C.mcpAccent }]}>NEW</Text>
            </TouchableOpacity>
          </View>

          {tools.map((t) => (
            <View key={t.id} style={[s.card, { marginBottom: 10 }]}>
              <View style={[s.row, { justifyContent: "space-between" }]}>
                <View style={{ flexShrink: 1, paddingRight: 8 }}>
                  <View style={s.row}>
                    <Text style={[s.toolName, { color: t.enabled ? C.mcpAccent : C.textDim }]}>{t.name}</Text>
                    {t.built_in && (
                      <View style={s.tag}>
                        <Text style={s.tagText}>BUILT-IN</Text>
                      </View>
                    )}
                  </View>
                  <Text style={s.toolDesc}>{t.description}</Text>
                </View>
                <Switch
                  value={t.enabled}
                  onValueChange={() => toggleToolEnabled(t)}
                  trackColor={{ false: C.border, true: C.greenDim }}
                  thumbColor={t.enabled ? C.green : C.textDim}
                />
              </View>
              <Text style={s.toolCmd} numberOfLines={2}>
                <Text style={{ color: C.textDim }}>$ </Text>{t.command_template}
              </Text>
              <View style={[s.row, { marginTop: 6, gap: 12 }]}>
                <Text style={s.toolMeta}>wrap: <Text style={{ color: C.cyan }}>{t.wrap_mode}</Text></Text>
                <Text style={s.toolMeta}>timeout: <Text style={{ color: C.cyan }}>{t.timeout_sec}s</Text></Text>
              </View>
              <View style={[s.row, { marginTop: 10, gap: 8 }]}>
                <TouchableOpacity
                  style={[s.smallBtn, { borderColor: C.cyan }]}
                  onPress={() => setEditingTool({ ...t })}
                >
                  <Text style={[s.smallBtnText, { color: C.cyan }]}>EDIT</Text>
                </TouchableOpacity>
                {!t.built_in && (
                  <TouchableOpacity
                    style={[s.smallBtn, { borderColor: C.red }]}
                    onPress={() => deleteTool(t)}
                  >
                    <Text style={[s.smallBtnText, { color: C.red }]}>DELETE</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          ))}

          {tools.length === 0 && (
            <Text style={s.helper}>{"// no tools registered — tap NEW to add one"}</Text>
          )}
        </ScrollView>
      )}

      {/* AUDIT PANE */}
      {subTab === "audit" && (
        <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 90 }}>
          <View style={[s.row, { justifyContent: "space-between", marginBottom: 12 }]}>
            <Text style={s.sectionTitle}>{"// audit log"}</Text>
            <TouchableOpacity
              style={[s.btn, { backgroundColor: C.panel2, borderColor: C.red }]}
              onPress={handleClearAudit}
              disabled={audit.length === 0}
            >
              <MaterialCommunityIcons name="trash-can-outline" size={14} color={C.red} />
              <Text style={[s.btnText, { color: C.red }]}>CLEAR</Text>
            </TouchableOpacity>
          </View>

          {audit.length === 0 ? (
            <View style={s.card}>
              <Text style={s.helper}>
                {"// no tool calls yet. enable the server in // status, then make a tool call (e.g. via Postman, curl, or Hermes). this list refreshes every 3s when the server is reachable."}
              </Text>
            </View>
          ) : (
            audit.map((e) => (
              <View key={e.id} style={[s.card, { marginBottom: 8 }]}>
                <View style={[s.row, { justifyContent: "space-between" }]}>
                  <Text style={[s.auditTool, { color: e.success ? C.green : C.red }]}>
                    {e.success ? "✓" : "✗"} {e.tool_name}
                  </Text>
                  <Text style={s.auditTs}>{formatTs(e.ts)}</Text>
                </View>
                <Text style={s.auditMeta}>
                  client=<Text style={{ color: C.cyan }}>{e.client_id || "(unknown)"}</Text>
                  {"  "}dur=<Text style={{ color: C.cyan }}>{e.duration_ms}ms</Text>
                  {"  "}exit=<Text style={{ color: e.exit_code === 0 ? C.green : C.red }}>{e.exit_code}</Text>
                </Text>
                <Text style={s.auditArgs} numberOfLines={2}>args: {e.args_json}</Text>
                {!!e.result_summary && (
                  <Text style={s.auditResult} numberOfLines={3}>→ {e.result_summary}</Text>
                )}
              </View>
            ))
          )}
        </ScrollView>
      )}

      {/* TOOL EDITOR MODAL (overlay) */}
      {editingTool && (
        <View style={s.overlay} pointerEvents="auto">
          <View style={s.sheet}>
            <View style={s.sheetHeader}>
              <Text style={s.sheetTitle}>
                {`// ${editingTool.id ? "edit tool" : "new tool"}`}
              </Text>
              <TouchableOpacity onPress={() => setEditingTool(null)}>
                <MaterialCommunityIcons name="close" size={22} color={C.green} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ paddingBottom: 20 }}>
              <Text style={s.kvLabel}>name *</Text>
              <TextInput
                style={s.input}
                value={editingTool.name || ""}
                onChangeText={(v) => setEditingTool({ ...editingTool, name: v })}
                placeholder="snake_case identifier, e.g. scan_aps"
                placeholderTextColor={C.textDim}
                editable={!editingTool.built_in}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {editingTool.built_in && (
                <Text style={s.helperFine}>built-in tools have locked names</Text>
              )}

              <Text style={[s.kvLabel, { marginTop: 12 }]}>description</Text>
              <TextInput
                style={[s.input, { minHeight: 60 }]}
                value={editingTool.description || ""}
                onChangeText={(v) => setEditingTool({ ...editingTool, description: v })}
                placeholder="what does this tool do? shown to the calling LLM."
                placeholderTextColor={C.textDim}
                multiline
              />

              <Text style={[s.kvLabel, { marginTop: 12 }]}>command template *</Text>
              <TextInput
                style={[s.input, { minHeight: 60 }]}
                value={editingTool.command_template || ""}
                onChangeText={(v) => setEditingTool({ ...editingTool, command_template: v })}
                placeholder="airodump-ng {iface}   or   __internal:foo"
                placeholderTextColor={C.textDim}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
              />
              <Text style={s.helperFine}>
                {"{name}"} tokens get JSON-schema-validated args interpolated.
              </Text>

              <Text style={[s.kvLabel, { marginTop: 12 }]}>arg schema (JSON)</Text>
              <TextInput
                style={[s.input, { minHeight: 100, fontFamily: MONO, fontSize: 12 }]}
                value={editingTool.arg_schema_json || "{}"}
                onChangeText={(v) => setEditingTool({ ...editingTool, arg_schema_json: v })}
                placeholder={'{"type":"object","properties":{...}}'}
                placeholderTextColor={C.textDim}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
              />

              <View style={[s.row, { gap: 12, marginTop: 12 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={s.kvLabel}>wrap mode</Text>
                  <View style={s.segGroupSmall}>
                    {(["auto", "kali", "android", "none"] as const).map((m) => (
                      <TouchableOpacity
                        key={m}
                        style={[s.segSmall, editingTool.wrap_mode === m && s.segSmallActive]}
                        onPress={() => setEditingTool({ ...editingTool, wrap_mode: m })}
                      >
                        <Text style={[s.segSmallText, editingTool.wrap_mode === m && { color: C.mcpAccent }]}>
                          {m}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
                <View style={{ width: 100 }}>
                  <Text style={s.kvLabel}>timeout (s)</Text>
                  <TextInput
                    style={s.input}
                    value={String(editingTool.timeout_sec ?? 60)}
                    onChangeText={(v) => setEditingTool({ ...editingTool, timeout_sec: parseInt(v, 10) || 60 })}
                    keyboardType="number-pad"
                  />
                </View>
              </View>

              <View style={[s.row, { gap: 8, marginTop: 18 }]}>
                <TouchableOpacity
                  style={[s.btn, { flex: 1, backgroundColor: C.panel2 }]}
                  onPress={() => setEditingTool(null)}
                >
                  <Text style={[s.btnText, { color: C.textDim }]}>CANCEL</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.btn, { flex: 1, backgroundColor: C.greenDim, borderColor: C.green }]}
                  onPress={saveTool}
                >
                  <MaterialCommunityIcons name="content-save" size={14} color={C.bg} />
                  <Text style={[s.btnText, { color: C.bg }]}>SAVE</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  subTabBar: {
    flexDirection: "row", borderBottomWidth: 1, borderColor: C.border,
    backgroundColor: C.panel,
  },
  subTabBtn: { flex: 1, paddingVertical: 12, alignItems: "center" },
  subTabBtnActive: { borderBottomWidth: 2, borderColor: C.mcpAccent },
  subTabText: { fontFamily: MONO, color: C.textDim, fontSize: 12, letterSpacing: 0.5 },
  sectionTitle: { fontFamily: MONO, color: C.textDim, fontSize: 12, letterSpacing: 0.5, marginBottom: 6 },
  card: {
    backgroundColor: C.panel, borderWidth: 1, borderColor: C.border,
    borderRadius: 6, padding: 12,
  },
  row: { flexDirection: "row", alignItems: "center" },
  helper: { fontFamily: MONO, color: C.text, fontSize: 12, lineHeight: 18 },
  helperFine: { fontFamily: MONO, color: C.textDim, fontSize: 11 },
  kvLabel: { fontFamily: MONO, color: C.textDim, fontSize: 11, marginBottom: 4 },
  statusDot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  statusText: { fontFamily: MONO, fontSize: 13, fontWeight: "700" },
  input: {
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.border,
    borderRadius: 4, paddingHorizontal: 10, paddingVertical: 8,
    color: C.text, fontFamily: MONO, fontSize: 13,
  },
  tokenBox: {
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.border,
    borderRadius: 4, padding: 10,
  },
  tokenText: { fontFamily: MONO, color: C.mcpAccent, fontSize: 12 },
  btn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 6, paddingVertical: 10, paddingHorizontal: 10,
    borderRadius: 4, borderWidth: 1, borderColor: C.border,
  },
  btnText: { fontFamily: MONO, fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  smallBtn: {
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 3, borderWidth: 1,
  },
  smallBtnText: { fontFamily: MONO, fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  toolName: { fontFamily: MONO, fontSize: 14, fontWeight: "700" },
  toolDesc: { fontFamily: MONO, color: C.text, fontSize: 11, marginTop: 4, lineHeight: 16 },
  toolCmd: { fontFamily: MONO, color: C.text, fontSize: 11, marginTop: 8 },
  toolMeta: { fontFamily: MONO, color: C.textDim, fontSize: 10 },
  tag: {
    marginLeft: 8, paddingHorizontal: 5, paddingVertical: 1,
    borderWidth: 1, borderColor: C.greenDim, borderRadius: 2,
  },
  tagText: { fontFamily: MONO, color: C.greenDim, fontSize: 9, letterSpacing: 0.5 },
  auditTool: { fontFamily: MONO, fontSize: 13, fontWeight: "700" },
  auditTs: { fontFamily: MONO, color: C.textDim, fontSize: 10 },
  auditMeta: { fontFamily: MONO, color: C.textDim, fontSize: 10, marginTop: 4 },
  auditArgs: { fontFamily: MONO, color: C.text, fontSize: 10, marginTop: 4 },
  auditResult: { fontFamily: MONO, color: C.cyan, fontSize: 10, marginTop: 2 },
  segGroupSmall: { flexDirection: "row", gap: 4 },
  segSmall: {
    flex: 1, paddingVertical: 8, alignItems: "center",
    borderRadius: 3, borderWidth: 1, borderColor: C.border,
  },
  segSmallActive: { borderColor: C.mcpAccent, backgroundColor: C.panel2 },
  segSmallText: { fontFamily: MONO, color: C.textDim, fontSize: 10, letterSpacing: 0.5 },
  overlay: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(4,7,10,0.92)", padding: 14, justifyContent: "center",
  },
  sheet: {
    backgroundColor: C.panel, borderWidth: 1, borderColor: C.mcpAccent,
    borderRadius: 6, padding: 16, maxHeight: "92%",
  },
  sheetHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    marginBottom: 14,
  },
  sheetTitle: { fontFamily: MONO, color: C.mcpAccent, fontSize: 14, fontWeight: "700" },
});
