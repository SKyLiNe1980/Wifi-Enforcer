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
import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  Alert, Platform, Switch,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import {
  mcpLocal, settingsLocal, nodesLocal,
  type MCPConfig, type MCPTool, type MCPAuditEntry, type MCPNode,
} from "../lib/localDb";
import { startStream, killStream, hasNativeStreaming, execReal, HAS_NATIVE_ROOT } from "../lib/rootShell";
import {
  prepareDebPayload, detectTailscaleIp, startHttpServer, stopHttpServer,
  buildInstallOneLiner,
  type DeployPayload, type HttpdHandle,
} from "../lib/deployServer";

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

type SubTab = "status" | "tools" | "nodes" | "audit";

export default function MCPTab() {
  const [subTab, setSubTab] = useState<SubTab>("status");
  const [config, setConfig] = useState<MCPConfig | null>(null);
  const [tools, setTools] = useState<MCPTool[]>([]);
  const [audit, setAudit] = useState<MCPAuditEntry[]>([]);
  const [nodes, setNodes] = useState<MCPNode[]>([]);
  // Each node tracked separately so one slow VPS doesn't slow the others.
  // Map<nodeId, "running"|"unreachable"|"error"|"probing"|"unknown">.
  const [nodeHealth, setNodeHealth] = useState<Record<string, string>>({});
  const [nodeToolCount, setNodeToolCount] = useState<Record<string, number>>({});
  const [editingNode, setEditingNode] = useState<Partial<MCPNode> | null>(null);
  const [busy, setBusy] = useState(false);
  const [tokenVisible, setTokenVisible] = useState(false);

  // Local form state — committed to SQLite via debounced updateConfig().
  const [portInput, setPortInput] = useState("8765");
  const [bindInput, setBindInput] = useState("127.0.0.1");
  const [probeInput, setProbeInput] = useState("127.0.0.1");
  const [autospawnCmdInput, setAutospawnCmdInput] = useState("");
  const [chrootCmdInput, setChrootCmdInput] = useState("");
  const [showAutospawnLog, setShowAutospawnLog] = useState(false);

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

  // ─── Tool registry sync ─────────────────────────────────────────────
  // Cockpit pulls GET /tools after first /health success, then on every
  // user-initiated [resync]. Without this the // tools tab stays frozen
  // at whatever was seeded into local SQLite (Phase 1A = 11) even though
  // the chroot server is happily registering new ones.
  const [toolSyncStatus, setToolSyncStatus] = useState<
    "idle" | "syncing" | "synced" | "failed"
  >("idle");
  const [toolSyncMsg, setToolSyncMsg] = useState<string>("");
  const lastToolSyncRef = useRef<number>(0);

  // ─── Chroot wrapping helper ─────────────────────────────────────────
  // The cockpit app runs in an isolated mount namespace (LineageOS
  // data_mirror sandbox) and CAN'T see the chroot mounts that bootkali
  // sets up at boot. To enter Kali we go through the *exact* path the
  // rest of the cockpit already uses: settings.chroot_path, which is
  // the `busybox_nh chroot /data/local/nhsystem/kalifs /usr/bin/sudo -E`
  // incantation set up at install time. We wrap with `bash -c '...'`
  // so the inner command can contain pipes / && / redirects without
  // escaping hell. Single-quotes inside get encoded as '\''.
  const wrapChrootCmd = useCallback(async (innerCmd: string): Promise<string> => {
    const s = await settingsLocal.get();
    const chrootPath = (s.chroot_path || "").trim();
    if (!chrootPath) return innerCmd;
    const escaped = innerCmd.replace(/'/g, "'\\''");
    return `${chrootPath} bash -c '${escaped}'`;
  }, []);
  // Have we run the auto-sync for THIS session of /health success?
  // Reset to false whenever serverHealth leaves "running" so we re-sync
  // after a server bounce.
  const didAutoToolSyncRef = useRef<boolean>(false);

  // ─── Autospawn state machine ────────────────────────────────────────
  // When autospawn_enabled and the cockpit can't reach the server, spawn
  // it via the native RootShell stream. We track the spawned session in
  // a ref so:
  //   • re-renders don't trigger another spawn
  //   • we don't spawn while a previous attempt is still settling
  //   • the cleanup on unmount can detach event listeners without
  //     killing the actual process (we WANT the server to keep running
  //     after the user leaves the tab)
  const autospawnSessionRef = useRef<string | null>(null);
  const autospawnUnsubRef = useRef<(() => void) | null>(null);
  const autospawnAttemptedAtRef = useRef<number>(0);
  const [autospawnStatus, setAutospawnStatus] = useState<
    "idle" | "spawning" | "running" | "exited" | "failed" | "disabled"
  >("disabled");
  const [autospawnLog, setAutospawnLog] = useState<string>("");
  const [autospawnPid, setAutospawnPid] = useState<number | null>(null);

  // Reading the config row also re-syncs the textinput shadow state.
  // We split this from refreshLists() — toggling a tool in the // tools
  // subtab does NOT need to reset the user's half-typed bind_host in
  // // status, which was causing the "0.0.0.0 keeps reverting to
  // 127.0.0.1" bug.
  const refreshConfig = useCallback(async () => {
    const c = await mcpLocal.getConfig();
    setConfig(c);
    setPortInput(String(c.port));
    setBindInput(c.bind_host);
    setProbeInput(c.cockpit_probe_host || "127.0.0.1");
    setAutospawnCmdInput(c.autospawn_cmd || "");
    setChrootCmdInput(c.chroot_yaml_cmd || "");
  }, []);

  const refreshLists = useCallback(async () => {
    const [t, a, n] = await Promise.all([
      mcpLocal.listTools(),
      mcpLocal.listAudit(200),
      nodesLocal.list(),
    ]);
    setTools(t);
    setAudit(a);
    setNodes(n);
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([refreshConfig(), refreshLists()]);
  }, [refreshConfig, refreshLists]);

  // ─── Tool sync helper (callable from health probe + manual button) ──
  const syncToolsNow = useCallback(async (
    base: string, token: string, opts: { silent?: boolean } = {},
  ) => {
    setToolSyncStatus("syncing");
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5000);
      let r: Response;
      try {
        r = await fetch(`${base}/tools`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: ctl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!r.ok) {
        setToolSyncStatus("failed");
        setToolSyncMsg(`HTTP ${r.status}`);
        return null;
      }
      const data = await r.json();
      const serverTools = Array.isArray(data?.tools) ? data.tools : [];
      const res = await mcpLocal.syncToolsFromServer(serverTools);
      setToolSyncStatus("synced");
      const msg = `+${res.inserted} new · ${res.updated} updated · ${res.total} total`;
      setToolSyncMsg(msg);
      lastToolSyncRef.current = Date.now();
      // Refresh visible tool list
      const newTools = await mcpLocal.listTools();
      setTools(newTools);
      if (!opts.silent) {
        Alert.alert("Tools synced", msg);
      }
      return res;
    } catch (e: any) {
      setToolSyncStatus("failed");
      setToolSyncMsg(e?.message || "fetch failed");
      if (!opts.silent) {
        Alert.alert("Tool sync failed", e?.message || "network error");
      }
      return null;
    }
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
        // Autospawn: clear failure backoff once server reachable
        setAutospawnStatus((cur) =>
          cur === "spawning" || cur === "failed" ? "running" : cur);
        // Auto-sync tools once per "running" streak (token must be set).
        if (!didAutoToolSyncRef.current && token) {
          didAutoToolSyncRef.current = true;
          syncToolsNow(base, token, { silent: true }).catch(() => {});
        }
      } catch (e: any) {
        if (cancelled) return;
        const msg = e?.message || String(e);
        // Network-level failure ≠ server bug. AbortError = our 3.5s timeout.
        const isUnreachable =
          msg.includes("Network") || msg.includes("aborted") ||
          msg.includes("Failed to fetch") || msg.includes("ECONNREFUSED") ||
          msg.includes("connect");
        if (isUnreachable) {
          setServerHealth("unreachable");
          // Reset the one-shot tool-sync gate so the NEXT successful
          // probe (after spawn / reconnect) re-syncs.
          didAutoToolSyncRef.current = false;
          // Autospawn: try once per 30s window when we hit unreachable.
          maybeAutospawn();
        } else {
          setServerHealth("error");
        }
        setProbeError(msg);
        setLastProbeAt(Date.now());
      }
    };

    // Spawn the chroot server via RootShell.executeStream. Idempotent in
    // practice: tries at most once per 30s, and refuses to re-trigger
    // while a previous spawn is still alive.
    const maybeAutospawn = () => {
      if (!config.autospawn_enabled) return;
      if (!config.autospawn_cmd?.trim()) {
        setAutospawnStatus("failed");
        setAutospawnLog("autospawn_cmd is empty");
        return;
      }
      if (!hasNativeStreaming()) {
        // Expo Go / web preview: can't spawn native streams. Stay quiet.
        setAutospawnStatus("disabled");
        return;
      }
      if (autospawnSessionRef.current) return;          // already running
      const since = Date.now() - autospawnAttemptedAtRef.current;
      // Hard 30 s cooldown between any two attempts. Avoids hammering
      // the root shell with bash fork bombs if e.g. the chroot path is
      // wrong and every spawn dies immediately.
      if (autospawnAttemptedAtRef.current && since < 30_000) return;

      autospawnAttemptedAtRef.current = Date.now();
      const sid = `mcp-autospawn-${Date.now()}`;
      setAutospawnStatus("spawning");
      setAutospawnLog("→ launching: " + config.autospawn_cmd);
      setAutospawnPid(null);

      // Wrap with chroot_path so the python server actually launches
      // *inside* Kali (not in the cockpit's isolated namespace).
      // startStream is fire-and-forget so we await wrapChrootCmd in an
      // async IIFE rather than awaiting maybeAutospawn itself.
      (async () => {
        const wrapped = await wrapChrootCmd(config.autospawn_cmd);
        const unsub = startStream(sid, wrapped, {
        onPid: (e) => {
          setAutospawnPid(e.pid);
          setAutospawnLog((prev) => prev + `\n[pid ${e.pid}]`);
        },
        onLine: (e) => {
          // Trim huge log — keep last ~30 lines worth.
          setAutospawnLog((prev) => {
            const next = prev + "\n" + e.line;
            if (next.length > 4000) return next.slice(-4000);
            return next;
          });
        },
        onExit: (e) => {
          setAutospawnPid(null);
          autospawnSessionRef.current = null;
          autospawnUnsubRef.current?.();
          autospawnUnsubRef.current = null;
          // exit_code 0 only if the user stopped it cleanly; the server
          // is supposed to run forever, so any exit during normal ops
          // counts as a failure for autospawn purposes.
          setAutospawnStatus(e.exit_code === 0 ? "exited" : "failed");
          setAutospawnLog((prev) => prev + `\n[exit ${e.exit_code} after ${e.duration_ms}ms]`);
        },
        onError: (e) => {
          autospawnSessionRef.current = null;
          autospawnUnsubRef.current?.();
          autospawnUnsubRef.current = null;
          setAutospawnPid(null);
          setAutospawnStatus("failed");
          setAutospawnLog((prev) => prev + `\n[error] ${e.message}`);
        },
      });
      autospawnSessionRef.current = sid;
      autospawnUnsubRef.current = unsub;
      })();   // close async IIFE
    };

    // Reset autospawn status when autospawn toggled off. Use functional
    // setter so we don't capture a stale value and only flip to "disabled"
    // when the user actively turns the feature off (preserve last status
    // for transparency on the // status pane).
    if (!config.autospawn_enabled && autospawnSessionRef.current === null) {
      setAutospawnStatus((cur) => (cur === "spawning" ? "disabled" : cur === "disabled" ? cur : "disabled"));
    } else if (config.autospawn_enabled) {
      setAutospawnStatus((cur) => (cur === "disabled" ? "idle" : cur));
    }

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
      // NOTE: we intentionally do NOT detach the autospawn listeners or
      // kill the spawned process here. The MCP server should keep running
      // even when the user leaves the // mcp tab. The listeners do leak
      // until app teardown, but the native bridge dedupes by sessionId
      // so memory is bounded.
    };
  }, [config?.server_enabled, config?.cockpit_probe_host, config?.port, config?.bearer_token, config?.autospawn_enabled, config?.autospawn_cmd, syncToolsNow]);  // eslint-disable-line react-hooks/exhaustive-deps

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

  const handleManualResync = useCallback(async () => {
    if (!config) return;
    const host = (config.cockpit_probe_host || "127.0.0.1").trim();
    const base = `http://${host}:${config.port}`;
    if (!config.bearer_token) {
      Alert.alert("No bearer token", "Generate or import a token first.");
      return;
    }
    await syncToolsNow(base, config.bearer_token, { silent: false });
  }, [config, syncToolsNow]);

  // ─── Per-remote-node health probe ───────────────────────────────────
  // Polls each enabled remote node's /health every 10s. Slower than the
  // cockpit's own loopback probe (which can afford 5s loopback) because
  // these are over Tailscale and we don't want to hammer a VPS. Runs all
  // probes in parallel via Promise.allSettled so a 3.5s timeout on one
  // dead node doesn't block the others. Snapshot results back to SQLite
  // so the // nodes view paints instantly on tab switch.
  const probeNode = useCallback(async (node: MCPNode) => {
    if (!node.enabled) return;
    setNodeHealth((p) => ({ ...p, [node.id]: "probing" }));
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 3500);
      let r: Response;
      try {
        r = await fetch(`http://${node.host}:${node.port}/health`, {
          signal: ctl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!r.ok) {
        setNodeHealth((p) => ({ ...p, [node.id]: "error" }));
        await nodesLocal.updateHealth(node.id, { status: "error" });
        return;
      }
      const info = await r.json();
      const toolCount = typeof info?.tools === "number" ? info.tools : null;
      setNodeHealth((p) => ({ ...p, [node.id]: "running" }));
      if (toolCount !== null) {
        setNodeToolCount((p) => ({ ...p, [node.id]: toolCount }));
      }
      await nodesLocal.updateHealth(node.id, {
        status: "running", info, tool_count: toolCount,
      });
    } catch (e: any) {
      const msg = e?.message || String(e);
      const isUnreachable = msg.includes("Network") || msg.includes("aborted") ||
        msg.includes("Failed to fetch") || msg.includes("ECONNREFUSED") ||
        msg.includes("connect");
      const status = isUnreachable ? "unreachable" : "error";
      setNodeHealth((p) => ({ ...p, [node.id]: status }));
      await nodesLocal.updateHealth(node.id, { status });
    }
  }, []);

  useEffect(() => {
    if (nodes.length === 0) return;
    let cancelled = false;
    const probeAll = () => {
      // Don't await — fire all in parallel; each settles independently.
      Promise.allSettled(nodes.filter((n) => n.enabled).map(probeNode));
    };
    probeAll();
    const t = setInterval(() => { if (!cancelled) probeAll(); }, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [nodes, probeNode]);

  // ─── Node CRUD ──────────────────────────────────────────────────────
  const handleSaveNode = useCallback(async () => {
    if (!editingNode) return;
    const name = (editingNode.name || "").trim();
    const host = (editingNode.host || "").trim();
    if (!name || !host) {
      Alert.alert("Missing fields", "Node needs at least a name and a host.");
      return;
    }
    try {
      if (editingNode.id) {
        await nodesLocal.update(editingNode.id, {
          name, host, port: editingNode.port ?? 8765,
          bearer_token: editingNode.bearer_token || "",
          tags: editingNode.tags || [],
          description: editingNode.description || "",
          enabled: editingNode.enabled ?? true,
        });
      } else {
        await nodesLocal.create({
          name, host, port: editingNode.port ?? 8765,
          bearer_token: editingNode.bearer_token || "",
          tags: editingNode.tags || [],
          description: editingNode.description || "",
          enabled: editingNode.enabled ?? true,
        });
      }
      setEditingNode(null);
      refreshLists();
    } catch (e: any) {
      Alert.alert("Save failed",
        (e?.message || "sqlite error") +
        (String(e?.message || "").includes("UNIQUE") ?
          "\n\nA node with this host:port already exists." : ""));
    }
  }, [editingNode, refreshLists]);

  const handleDeleteNode = useCallback((node: MCPNode) => {
    Alert.alert(
      `Delete node "${node.name}"?`,
      `Removes ${node.host}:${node.port} from the cockpit. The node itself keeps running.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete", style: "destructive",
          onPress: async () => {
            await nodesLocal.delete(node.id);
            refreshLists();
          },
        },
      ],
    );
  }, [refreshLists]);

  const handleSetPrimaryNode = useCallback(async (node: MCPNode) => {
    await nodesLocal.setPrimary(node.id);
    refreshLists();
  }, [refreshLists]);

  const handleResyncNodeTools = useCallback(async (node: MCPNode) => {
    if (!node.bearer_token) {
      Alert.alert("No bearer token", "Node needs a token before /tools can be fetched.");
      return;
    }
    const base = `http://${node.host}:${node.port}`;
    const res = await syncToolsNow(base, node.bearer_token, { silent: false });
    if (res) {
      await nodesLocal.markToolSync(node.id, res.total);
      refreshLists();
    }
  }, [syncToolsNow, refreshLists]);


  // ─── Tier 1 deploy state ────────────────────────────────────────────
  // The user taps [DEPLOY NEW NODE], we:
  //   1. stage the bundled .deb on /data/local/tmp via root
  //   2. detect tailnet IP
  //   3. start busybox httpd bound to that IP
  //   4. show a copy-pasteable curl one-liner
  // Modal stays open until user taps STOP — busybox httpd has no
  // built-in auto-shutoff.
  type DeployStage =
    | "idle"
    | "preparing"
    | "ready"
    | "serving"
    | "stopped"
    | "failed";
  const [deployOpen, setDeployOpen] = useState(false);
  const [deployStage, setDeployStage] = useState<DeployStage>("idle");
  const [deployPayload, setDeployPayload] = useState<DeployPayload | null>(null);
  const [deployTailnetIp, setDeployTailnetIp] = useState<string | null>(null);
  const [deployPort, setDeployPort] = useState<string>("8088");
  const [deployHandle, setDeployHandle] = useState<HttpdHandle | null>(null);
  const [deployError, setDeployError] = useState<string>("");
  const [deployAccessLog, setDeployAccessLog] = useState<string[]>([]);

  const handleOpenDeploy = useCallback(async () => {
    setDeployOpen(true);
    setDeployError("");
    setDeployAccessLog([]);
    setDeployStage("preparing");
    try {
      const [payload, ip] = await Promise.all([
        prepareDebPayload(),
        detectTailscaleIp(),
      ]);
      setDeployPayload(payload);
      setDeployTailnetIp(ip);
      setDeployStage("ready");
      if (!ip) {
        setDeployError(
          "tailscale0 interface not found — make sure Tailscale is up " +
          "on this device. You can still deploy manually via scp.",
        );
      }
    } catch (e: any) {
      setDeployStage("failed");
      setDeployError(e?.message || "stage prep failed");
    }
  }, []);

  const handleStartDeployServer = useCallback(() => {
    if (!deployTailnetIp) {
      setDeployError("Cannot start: no tailnet IP detected.");
      return;
    }
    const port = parseInt(deployPort, 10);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setDeployError("Port must be 1024..65535.");
      return;
    }
    setDeployError("");
    setDeployAccessLog([]);
    const h = startHttpServer({
      ip: deployTailnetIp,
      port,
      onAccessLog: (line) => {
        setDeployAccessLog((prev) => {
          const next = [...prev, line];
          return next.length > 80 ? next.slice(-80) : next;
        });
      },
      onExit: (code) => {
        setDeployStage((cur) => (cur === "serving" ? "stopped" : cur));
        setDeployAccessLog((prev) => [...prev, `[exit ${code}]`]);
      },
      onError: (msg) => {
        setDeployStage("failed");
        setDeployError(msg);
      },
    });
    setDeployHandle(h);
    setDeployStage("serving");
  }, [deployTailnetIp, deployPort]);

  const handleStopDeployServer = useCallback(async () => {
    if (deployHandle) {
      await stopHttpServer(deployHandle.sessionId);
      setDeployHandle(null);
    }
    setDeployStage("stopped");
  }, [deployHandle]);

  const handleCloseDeploy = useCallback(async () => {
    // Be paranoid: if user closes the modal mid-serve, stop httpd so
    // we don't leave a dangling listener bound to the tailnet IP.
    if (deployHandle) {
      await stopHttpServer(deployHandle.sessionId).catch(() => {});
      setDeployHandle(null);
    }
    setDeployOpen(false);
    setDeployStage("idle");
    setDeployError("");
    setDeployAccessLog([]);
    setDeployPayload(null);
  }, [deployHandle]);

  const handleCopyOneLiner = useCallback(async () => {
    if (!deployTailnetIp) return;
    const port = parseInt(deployPort, 10) || 8088;
    const oneLiner = buildInstallOneLiner(deployTailnetIp, port, { printToken: true });
    await Clipboard.setStringAsync(oneLiner);
    Alert.alert("Copied", "One-liner copied — paste into target node's shell over SSH.");
  }, [deployTailnetIp, deployPort]);


  // Shells out via RootShell.exec to read the chroot's config.yaml and
  // pulls bearer_token / port / bind_host into local SQLite. Solves the
  // post-EAS-install reset problem AND the user's manual copy-token-to-
  // clipboard ritual in one shot.
  const [chrootSyncStatus, setChrootSyncStatus] = useState<
    "idle" | "running" | "ok" | "failed"
  >("idle");
  const [chrootSyncMsg, setChrootSyncMsg] = useState<string>("");
  const didAutoChrootSyncRef = useRef<boolean>(false);

  const handleChrootSync = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!config) return null;
    const cmd = (config.chroot_yaml_cmd || "").trim();
    if (!cmd) {
      if (!opts.silent) Alert.alert("No command set", "Configure chroot_yaml_cmd first.");
      return null;
    }
    if (!HAS_NATIVE_ROOT) {
      if (!opts.silent) {
        Alert.alert("Root shell unavailable",
          "This works only on the deployed APK (not Expo Go / web preview). " +
          "Use IMPORT (clipboard) instead.");
      }
      return null;
    }
    setChrootSyncStatus("running");
    setChrootSyncMsg("reading chroot yaml…");
    try {
      // Wrap the inner cmd with settings.chroot_path so we actually
      // cross the data_mirror boundary into Kali.
      const wrapped = await wrapChrootCmd(cmd);
      const res = await execReal(wrapped);
      // execReal returns { output, exit_code, ... }. exit_code != 0 usually
      // means: chroot not mounted, file missing, or permission denied.
      if (res.exit_code !== 0 && !res.output) {
        throw new Error(`shell exit ${res.exit_code}: ${res.output || "(no output)"}`);
      }
      const parsed = await mcpLocal.applyChrootYaml(res.output || "");
      if (parsed.imported.length === 0) {
        setChrootSyncStatus("failed");
        const msg = `nothing imported (skipped: ${parsed.skipped.join(", ") || "none"})`;
        setChrootSyncMsg(msg);
        if (!opts.silent) {
          Alert.alert("No fields imported",
            "The shell ran but no bearer_token_hex / port / host keys were found in the output.\n\n" +
            "First 200 chars of output:\n" + (res.output || "").slice(0, 200));
        }
        return parsed;
      }
      setChrootSyncStatus("ok");
      setChrootSyncMsg(`✓ imported ${parsed.imported.join(", ")}`);
      // Reload everything from SQLite so all the UI form state lines up.
      await refresh();
      if (!opts.silent) {
        Alert.alert("Synced from chroot",
          `Imported: ${parsed.imported.join(", ")}\n` +
          (parsed.skipped.length ? `\nSkipped: ${parsed.skipped.join(", ")}` : "") +
          `\n\nbearer_token: ${parsed.raw.bearer_token_hex ? parsed.raw.bearer_token_hex.slice(0,8)+"…"+parsed.raw.bearer_token_hex.slice(-4) : "—"}` +
          `\nport: ${parsed.raw.port ?? "—"}` +
          `\nhost: ${parsed.raw.host ?? "—"}`);
      }
      return parsed;
    } catch (e: any) {
      setChrootSyncStatus("failed");
      setChrootSyncMsg(`✗ ${e?.message || "shell error"}`);
      if (!opts.silent) {
        Alert.alert("Chroot sync failed",
          (e?.message || "shell error") +
          "\n\nCheck that:\n• Chroot is mounted\n• Path in chroot_yaml_cmd is correct\n• `nethunter` wrapper exists");
      }
      return null;
    }
  }, [config, refresh, wrapChrootCmd]);

  // ─── First-mount chroot auto-import ─────────────────────────────────
  // If the bearer token is empty AND chroot_autosync_enabled is on AND
  // root shell is available, automatically read the chroot YAML to
  // self-heal after an EAS install (which wipes SQLite + sometimes
  // SecureStore). Runs once per mount. Placed AFTER handleChrootSync
  // declaration to avoid TS use-before-assign.
  useEffect(() => {
    if (!config) return;
    if (didAutoChrootSyncRef.current) return;
    if (!HAS_NATIVE_ROOT) return;
    if (!config.chroot_autosync_enabled) return;
    // Only auto-fire if bearer is genuinely empty (post-install). Don't
    // overwrite a user who just typed their token in manually.
    if (config.bearer_token && config.bearer_token.length >= 16) return;
    didAutoChrootSyncRef.current = true;
    handleChrootSync({ silent: true }).catch((e) =>
      console.warn("[MCPTab] auto chroot-sync failed:", e),
    );
  }, [config, handleChrootSync]);

  const handleStopAutospawn = useCallback(async () => {
    const sid = autospawnSessionRef.current;
    if (!sid) return;
    Alert.alert(
      "Stop server?",
      "Send SIGTERM to the autospawned MCP server (PID " +
        (autospawnPid ?? "?") + "). It will respawn on the next health-poll failure unless you also turn autospawn OFF.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Stop", style: "destructive",
          onPress: async () => {
            await killStream(sid, true).catch(() => {});
            autospawnSessionRef.current = null;
            autospawnUnsubRef.current?.();
            autospawnUnsubRef.current = null;
            setAutospawnStatus("exited");
            setAutospawnPid(null);
          },
        },
      ],
    );
  }, [autospawnPid]);

  // ─── Tools CRUD ─────────────────────────────────────────────────────────
  // CRUD operations use refreshLists() rather than full refresh() so they
  // don't reset the user's in-progress IP/port/cmd input edits in the
  // // status subtab.
  const toggleToolEnabled = useCallback(async (t: MCPTool) => {
    await mcpLocal.upsertTool({ ...t, enabled: !t.enabled });
    refreshLists();
  }, [refreshLists]);

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
      refreshLists();
    } catch (e: any) {
      Alert.alert("Save failed", e?.message || "sqlite error");
    }
  }, [editingTool, refreshLists]);

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
          onPress: async () => { await mcpLocal.deleteTool(t.id); refreshLists(); },
        },
      ],
    );
  }, [refreshLists]);

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
        {(["status", "tools", "nodes", "audit"] as SubTab[]).map((st) => (
          <TouchableOpacity
            key={st}
            onPress={() => setSubTab(st)}
            style={[s.subTabBtn, subTab === st && s.subTabBtnActive]}
            activeOpacity={0.7}
          >
            <Text style={[s.subTabText, subTab === st && { color: C.mcpAccent }]}>
              {st === "status" ? "// status"
                : st === "tools" ? `// tools (${tools.length})`
                : st === "nodes" ? `// nodes (${nodes.length})`
                : `// audit (${audit.length})`}
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
                {toolSyncStatus !== "idle" && (
                  <Text style={[s.helperFine, { marginTop: 4 }]}>
                    tool sync: <Text style={{
                      color: toolSyncStatus === "synced" ? C.green
                        : toolSyncStatus === "syncing" ? C.yellow : C.red,
                    }}>{toolSyncStatus}</Text>
                    {toolSyncMsg ? <Text style={{ color: C.textDim }}>{"  ·  " + toolSyncMsg}</Text> : null}
                  </Text>
                )}
                {probeError && serverHealth !== "running" && (
                  <Text style={[s.helperFine, { marginTop: 6, color: C.red }]}>
                    err: {probeError}
                  </Text>
                )}
              </View>

              {/* AUTOSPAWN CARD — only meaningful when server_enabled */}
              <Text style={[s.sectionTitle, { marginTop: 20 }]}>{"// autospawn"}</Text>
              <View style={s.card}>
                <View style={[s.row, { justifyContent: "space-between" }]}>
                  <Text style={s.kvLabel}>auto-launch chroot server on unreachable</Text>
                  <Switch
                    value={config.autospawn_enabled}
                    onValueChange={(v) => patchConfig({ autospawn_enabled: v })}
                    trackColor={{ false: C.border, true: C.greenDim }}
                    thumbColor={config.autospawn_enabled ? C.green : C.textDim}
                  />
                </View>
                <Text style={[s.helperFine, { marginTop: 6 }]}>
                  when on, the cockpit runs the command below via root shell
                  the moment a /health probe fails. cooldown: 30 s between
                  attempts. requires a working chroot wrapper (default uses
                  <Text style={{ color: C.cyan }}> nethunter -c</Text>).
                </Text>

                <Text style={[s.kvLabel, { marginTop: 12 }]}>spawn command</Text>
                <TextInput
                  style={[s.input, { minHeight: 70, fontFamily: MONO, fontSize: 11 }]}
                  value={autospawnCmdInput}
                  onChangeText={setAutospawnCmdInput}
                  onBlur={() => {
                    const v = autospawnCmdInput.trim();
                    if (v && v !== config.autospawn_cmd) {
                      patchConfig({ autospawn_cmd: v });
                    }
                  }}
                  placeholder='nethunter -c "cd /opt/enforcer-mcp && python3 server.py --config /etc/enforcer-mcp/config.yaml"'
                  placeholderTextColor={C.textDim}
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline
                />

                <View style={[s.row, { marginTop: 10, justifyContent: "space-between" }]}>
                  <Text style={s.helperFine}>
                    status: <Text style={{
                      color:
                        autospawnStatus === "running" ? C.green :
                        autospawnStatus === "spawning" ? C.yellow :
                        autospawnStatus === "failed" ? C.red :
                        autospawnStatus === "exited" ? C.yellow :
                        C.textDim,
                    }}>{autospawnStatus.toUpperCase()}</Text>
                    {autospawnPid !== null ? (
                      <Text style={{ color: C.textDim }}>{`  ·  pid ${autospawnPid}`}</Text>
                    ) : null}
                  </Text>
                  <View style={[s.row, { gap: 6 }]}>
                    {autospawnLog ? (
                      <TouchableOpacity
                        style={[s.smallBtn, { borderColor: C.cyan }]}
                        onPress={() => setShowAutospawnLog((v) => !v)}
                      >
                        <Text style={[s.smallBtnText, { color: C.cyan }]}>
                          {showAutospawnLog ? "HIDE LOG" : "LOG"}
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                    {autospawnSessionRef.current ? (
                      <TouchableOpacity
                        style={[s.smallBtn, { borderColor: C.red }]}
                        onPress={handleStopAutospawn}
                      >
                        <Text style={[s.smallBtnText, { color: C.red }]}>STOP</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>

                {showAutospawnLog && autospawnLog ? (
                  <View style={[s.tokenBox, { marginTop: 10 }]}>
                    <Text style={[s.helperFine, { fontSize: 10, color: C.text }]}>
                      {autospawnLog.trim()}
                    </Text>
                  </View>
                ) : null}

                {!hasNativeStreaming() && (
                  <Text style={[s.helperFine, { marginTop: 8, color: C.yellow }]}>
                    ⚠ native streaming bridge not detected — autospawn will no-op.
                    works only on the deployed APK, not Expo Go / web preview.
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
              safe before reinstalling the APK — or use SYNC FROM CHROOT below to
              auto-pull it from /etc/enforcer-mcp/config.yaml after every install.
            </Text>
          </View>

          {/* CHROOT YAML AUTO-IMPORT CARD ─────────────────────────── */}
          <Text style={[s.sectionTitle, { marginTop: 20 }]}>{"// auto-import from chroot yaml"}</Text>
          <View style={s.card}>
            <Text style={s.helperFine}>
              shell into the chroot and read{" "}
              <Text style={{ color: C.cyan }}>/etc/enforcer-mcp/config.yaml</Text>
              {" "}directly — bearer token, port, bind host all imported in one tap.
              solves the EAS-install wipe problem without manual clipboard dance.
            </Text>

            <View style={[s.row, { justifyContent: "space-between", marginTop: 12 }]}>
              <Text style={s.kvLabel}>auto-sync on app start when token empty</Text>
              <Switch
                value={config.chroot_autosync_enabled}
                onValueChange={(v) => patchConfig({ chroot_autosync_enabled: v })}
                trackColor={{ false: C.border, true: C.greenDim }}
                thumbColor={config.chroot_autosync_enabled ? C.green : C.textDim}
              />
            </View>
            <Text style={[s.helperFine, { marginTop: 4 }]}>
              when on, the cockpit reads the chroot yaml automatically on every
              app launch IF the bearer token is empty (typical post-install).
              never overwrites a token you&apos;ve already imported manually.
            </Text>

            <Text style={[s.kvLabel, { marginTop: 14 }]}>chroot read command</Text>
            <TextInput
              style={[s.input, { fontFamily: MONO, fontSize: 11 }]}
              value={chrootCmdInput}
              onChangeText={setChrootCmdInput}
              onBlur={() => {
                const v = chrootCmdInput.trim();
                if (v && v !== config.chroot_yaml_cmd) {
                  patchConfig({ chroot_yaml_cmd: v });
                }
              }}
              placeholder='nethunter -c "cat /etc/enforcer-mcp/config.yaml"'
              placeholderTextColor={C.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />

            <View style={[s.row, { marginTop: 12, gap: 6 }]}>
              <TouchableOpacity
                style={[s.btn, { flex: 1, backgroundColor: C.panel2, borderColor: C.green }]}
                onPress={() => handleChrootSync({ silent: false })}
                disabled={chrootSyncStatus === "running" || !HAS_NATIVE_ROOT}
              >
                <MaterialCommunityIcons
                  name={chrootSyncStatus === "running" ? "sync" : "database-import-outline"}
                  size={14}
                  color={C.green}
                />
                <Text style={[s.btnText, { color: C.green }]}>
                  {chrootSyncStatus === "running" ? "READING…" : "SYNC FROM CHROOT"}
                </Text>
              </TouchableOpacity>
            </View>

            {chrootSyncMsg ? (
              <Text style={[s.helperFine, {
                marginTop: 8,
                color: chrootSyncStatus === "ok" ? C.green :
                       chrootSyncStatus === "failed" ? C.red : C.yellow,
              }]}>
                {chrootSyncMsg}
              </Text>
            ) : null}

            {config.last_chroot_sync_at ? (
              <Text style={[s.helperFine, { marginTop: 4, color: C.textDim }]}>
                last successful sync: {new Date(config.last_chroot_sync_at).toLocaleString()}
              </Text>
            ) : null}

            {!HAS_NATIVE_ROOT && (
              <Text style={[s.helperFine, { marginTop: 8, color: C.yellow }]}>
                ⚠ root shell unavailable — works only on the deployed APK,
                not Expo Go / web preview.
              </Text>
            )}
          </View>

          <Text style={[s.sectionTitle, { marginTop: 20 }]}>{"// roadmap"}</Text>
          <View style={s.card}>
            <Text style={s.helper}>
              <Text style={{ color: C.green }}>✓</Text> 1A  · UI + persistence{"\n"}
              <Text style={{ color: C.green }}>✓</Text> 1B.1 · FastMCP server (chroot){"\n"}
              <Text style={{ color: C.green }}>✓</Text> 1B.2a · live probe + audit sync{"\n"}
              <Text style={{ color: C.green }}>✓</Text> 1B.2b · cockpit autospawn + tool sync{"\n"}
              <Text style={{ color: C.green }}>✓</Text> 1C  · real PTY-backed sessions (chroot){"\n"}
              <Text style={{ color: C.green }}>✓</Text> 1D-A · Hermes env injection (terminal){"\n"}
              <Text style={{ color: C.green }}>✓</Text> 2.A · Nodes tab + enforcer-node .deb{"\n"}
              <Text style={{ color: C.green }}>✓</Text> 2.B · Tier 1 in-app deploy (httpd over tailnet){"\n"}
              <Text style={{ color: C.textDim }}>·</Text> 2.C · Tier 2/3 SSH push deploy{"\n"}
              <Text style={{ color: C.textDim }}>·</Text> 3   · EUEF MCP wrapper · airodump live parser
            </Text>
          </View>
        </ScrollView>
      )}

      {/* TOOLS PANE */}
      {subTab === "tools" && (
        <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 90 }}>
          <View style={[s.row, { justifyContent: "space-between", marginBottom: 12 }]}>
            <Text style={s.sectionTitle}>{"// registered tools"}</Text>
            <View style={[s.row, { gap: 6 }]}>
              <TouchableOpacity
                style={[s.btn, { backgroundColor: C.panel2, borderColor: C.cyan }]}
                onPress={handleManualResync}
                disabled={toolSyncStatus === "syncing"}
              >
                <MaterialCommunityIcons
                  name={toolSyncStatus === "syncing" ? "sync" : "cloud-download-outline"}
                  size={14}
                  color={C.cyan}
                />
                <Text style={[s.btnText, { color: C.cyan }]}>
                  {toolSyncStatus === "syncing" ? "SYNCING…" : "RESYNC"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.btn, { backgroundColor: C.panel2, borderColor: C.mcpAccent }]}
                onPress={() => setEditingTool({ name: "", command_template: "", wrap_mode: "auto", timeout_sec: 60, enabled: true, built_in: false })}
              >
                <MaterialCommunityIcons name="plus" size={14} color={C.mcpAccent} />
                <Text style={[s.btnText, { color: C.mcpAccent }]}>NEW</Text>
              </TouchableOpacity>
            </View>
          </View>

          {toolSyncStatus !== "idle" && toolSyncMsg ? (
            <Text style={[s.helperFine, {
              marginBottom: 10,
              color: toolSyncStatus === "synced" ? C.green
                : toolSyncStatus === "failed" ? C.red : C.yellow,
            }]}>
              {toolSyncStatus === "synced" ? "✓ " : toolSyncStatus === "failed" ? "✗ " : "↻ "}
              {toolSyncMsg}
            </Text>
          ) : null}

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
                    {t.source === "server" && (
                      <View style={[s.tag, { borderColor: C.cyan, marginLeft: 4 }]}>
                        <Text style={[s.tagText, { color: C.cyan }]}>SERVER</Text>
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

      {/* NODES PANE */}
      {subTab === "nodes" && (
        <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 90 }}>
          <View style={[s.row, { justifyContent: "space-between", marginBottom: 12 }]}>
            <Text style={s.sectionTitle}>{"// swarm nodes"}</Text>
            <View style={[s.row, { gap: 6 }]}>
              <TouchableOpacity
                style={[s.btn, { backgroundColor: C.panel2, borderColor: C.green }]}
                onPress={handleOpenDeploy}
                disabled={!HAS_NATIVE_ROOT}
              >
                <MaterialCommunityIcons name="rocket-launch-outline" size={14}
                  color={HAS_NATIVE_ROOT ? C.green : C.textDim} />
                <Text style={[s.btnText, { color: HAS_NATIVE_ROOT ? C.green : C.textDim }]}>
                  DEPLOY NEW NODE
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.btn, { backgroundColor: C.panel2, borderColor: C.mcpAccent }]}
                onPress={() => setEditingNode({
                  name: "", host: "", port: 8765, bearer_token: "",
                  tags: [], description: "", enabled: true,
                })}
              >
                <MaterialCommunityIcons name="plus" size={14} color={C.mcpAccent} />
                <Text style={[s.btnText, { color: C.mcpAccent }]}>ADD NODE</Text>
              </TouchableOpacity>
            </View>
          </View>

          {nodes.length === 0 ? (
            <View style={s.card}>
              <Text style={s.helper}>
                No remote nodes yet. Deploy the{" "}
                <Text style={{ color: C.cyan }}>enforcer-mcp_*.deb</Text> on a
                Pi / VPS / mini-PC, grab the bearer token from its postinst
                output, and tap{" "}
                <Text style={{ color: C.mcpAccent }}>[+ ADD NODE]</Text> above.
              </Text>
              <Text style={[s.helperFine, { marginTop: 8 }]}>
                The cockpit&apos;s own chroot MCP server stays managed under{" "}
                <Text style={{ color: C.cyan }}>{"// status"}</Text>.
              </Text>
            </View>
          ) : (
            nodes.map((n) => {
              const health = nodeHealth[n.id] || n.last_health_status || "unknown";
              const toolCount = nodeToolCount[n.id] ?? n.last_tool_count;
              const dotColor =
                health === "running" ? C.green :
                health === "probing" ? C.yellow :
                health === "unreachable" ? C.textDim :
                C.red;
              return (
                <View key={n.id} style={[s.card, { marginBottom: 10 }]}>
                  <View style={[s.row, { justifyContent: "space-between" }]}>
                    <View style={[s.row, { flexShrink: 1, flex: 1, paddingRight: 8 }]}>
                      <View style={{
                        width: 8, height: 8, borderRadius: 4,
                        backgroundColor: dotColor, marginRight: 8,
                      }} />
                      <Text style={[s.toolName, { color: n.enabled ? C.mcpAccent : C.textDim }]}>
                        {n.name}
                      </Text>
                      {n.is_primary && (
                        <View style={[s.tag, { borderColor: C.yellow, marginLeft: 6 }]}>
                          <Text style={[s.tagText, { color: C.yellow }]}>PRIMARY</Text>
                        </View>
                      )}
                    </View>
                    <Switch
                      value={n.enabled}
                      onValueChange={async (v) => {
                        await nodesLocal.update(n.id, { enabled: v });
                        refreshLists();
                      }}
                      trackColor={{ false: C.border, true: C.greenDim }}
                      thumbColor={n.enabled ? C.green : C.textDim}
                    />
                  </View>

                  <Text style={[s.helperFine, { marginTop: 6 }]}>
                    <Text style={{ color: C.cyan }}>http://{n.host}:{n.port}</Text>
                    {"  ·  "}
                    <Text style={{ color: dotColor }}>{health.toUpperCase()}</Text>
                    {toolCount !== null && toolCount !== undefined ? (
                      <Text style={{ color: C.textDim }}>{`  ·  ${toolCount} tools`}</Text>
                    ) : null}
                  </Text>

                  {n.description ? (
                    <Text style={[s.helperFine, { marginTop: 4, color: C.textDim }]}>
                      {n.description}
                    </Text>
                  ) : null}

                  {n.tags.length > 0 && (
                    <View style={[s.row, { marginTop: 6, flexWrap: "wrap", gap: 4 }]}>
                      {n.tags.map((tag) => (
                        <View key={tag} style={[s.tag, { borderColor: C.textDim }]}>
                          <Text style={[s.tagText, { color: C.textDim }]}>{tag}</Text>
                        </View>
                      ))}
                    </View>
                  )}

                  <View style={[s.row, { marginTop: 10, gap: 6, flexWrap: "wrap" }]}>
                    <TouchableOpacity
                      style={[s.smallBtn, {
                        borderColor: health === "probing" ? C.yellow : C.green,
                      }]}
                      onPress={() => probeNode(n)}
                      disabled={!n.enabled || health === "probing"}
                    >
                      <Text style={[s.smallBtnText, {
                        color: !n.enabled ? C.textDim
                          : health === "probing" ? C.yellow : C.green,
                      }]}>
                        {health === "probing" ? "PROBING…" : "RETRY PROBE"}
                      </Text>
                    </TouchableOpacity>
                    {!n.is_primary && (
                      <TouchableOpacity
                        style={[s.smallBtn, { borderColor: C.yellow }]}
                        onPress={() => handleSetPrimaryNode(n)}
                      >
                        <Text style={[s.smallBtnText, { color: C.yellow }]}>SET PRIMARY</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={[s.smallBtn, { borderColor: C.cyan }]}
                      onPress={() => handleResyncNodeTools(n)}
                      disabled={!n.bearer_token || health !== "running"}
                    >
                      <Text style={[s.smallBtnText, {
                        color: (!n.bearer_token || health !== "running") ? C.textDim : C.cyan,
                      }]}>SYNC TOOLS</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[s.smallBtn, { borderColor: C.mcpAccent }]}
                      onPress={() => setEditingNode({ ...n })}
                    >
                      <Text style={[s.smallBtnText, { color: C.mcpAccent }]}>EDIT</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[s.smallBtn, { borderColor: C.red }]}
                      onPress={() => handleDeleteNode(n)}
                    >
                      <Text style={[s.smallBtnText, { color: C.red }]}>DELETE</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })
          )}

          <Text style={[s.helperFine, { marginTop: 12, color: C.textDim }]}>
            Probe interval: 10 s · Add each node&apos;s public Tailscale IP +
            port + bearer (printed by postinst). The cockpit caches health
            state in SQLite so this list paints instantly on tab switch.
          </Text>
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

      {/* NODE EDIT MODAL */}
      {editingNode && (
        <View style={s.overlay} pointerEvents="auto">
          <View style={s.sheet}>
            <View style={s.sheetHeader}>
              <Text style={s.sheetTitle}>
                {`// ${editingNode.id ? "edit node" : "new node"}`}
              </Text>
              <TouchableOpacity onPress={() => setEditingNode(null)}>
                <MaterialCommunityIcons name="close" size={22} color={C.green} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ paddingBottom: 20 }}>
              <Text style={s.kvLabel}>name *</Text>
              <TextInput
                style={s.input}
                value={editingNode.name || ""}
                onChangeText={(v) => setEditingNode((p) => p ? { ...p, name: v } : p)}
                placeholder="vps-1, pi-bedroom, etc."
                placeholderTextColor={C.textDim}
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={[s.kvLabel, { marginTop: 12 }]}>host * (tailscale IP or hostname)</Text>
              <TextInput
                style={[s.input, { fontFamily: MONO }]}
                value={editingNode.host || ""}
                onChangeText={(v) => setEditingNode((p) => p ? { ...p, host: v.trim() } : p)}
                placeholder="100.x.y.z or vps-1.tailnet.ts.net"
                placeholderTextColor={C.textDim}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />

              <Text style={[s.kvLabel, { marginTop: 12 }]}>port</Text>
              <TextInput
                style={[s.input, { fontFamily: MONO }]}
                value={String(editingNode.port ?? 8765)}
                onChangeText={(v) => {
                  const n = parseInt(v.replace(/[^\d]/g, ""), 10);
                  setEditingNode((p) => p ? {
                    ...p, port: isNaN(n) ? 8765 : Math.min(65535, Math.max(1, n)),
                  } : p);
                }}
                keyboardType="number-pad"
                placeholder="8765"
                placeholderTextColor={C.textDim}
              />

              <Text style={[s.kvLabel, { marginTop: 12 }]}>bearer token (from postinst)</Text>
              <View style={s.row}>
                <TextInput
                  style={[s.input, { flex: 1, fontFamily: MONO, fontSize: 11 }]}
                  value={editingNode.bearer_token || ""}
                  onChangeText={(v) => setEditingNode((p) => p ? { ...p, bearer_token: v.trim() } : p)}
                  placeholder="64-hex-char token"
                  placeholderTextColor={C.textDim}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry={false}
                />
                <TouchableOpacity
                  style={[s.smallBtn, { marginLeft: 6, borderColor: C.cyan }]}
                  onPress={async () => {
                    const t = (await Clipboard.getStringAsync()).trim();
                    if (t) setEditingNode((p) => p ? { ...p, bearer_token: t } : p);
                  }}
                >
                  <Text style={[s.smallBtnText, { color: C.cyan }]}>PASTE</Text>
                </TouchableOpacity>
              </View>

              <Text style={[s.kvLabel, { marginTop: 12 }]}>tags (comma-separated)</Text>
              <TextInput
                style={s.input}
                value={(editingNode.tags || []).join(", ")}
                onChangeText={(v) => setEditingNode((p) => p ? {
                  ...p,
                  tags: v.split(",").map((s) => s.trim()).filter(Boolean),
                } : p)}
                placeholder="vps, amd64, public-cloud"
                placeholderTextColor={C.textDim}
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={[s.kvLabel, { marginTop: 12 }]}>description</Text>
              <TextInput
                style={[s.input, { minHeight: 50 }]}
                value={editingNode.description || ""}
                onChangeText={(v) => setEditingNode((p) => p ? { ...p, description: v } : p)}
                placeholder="optional — what's this node for?"
                placeholderTextColor={C.textDim}
                multiline
              />

              <View style={[s.row, { marginTop: 16, justifyContent: "space-between" }]}>
                <TouchableOpacity
                  style={[s.btn, { backgroundColor: C.panel2, borderColor: C.textDim, flex: 1, marginRight: 6 }]}
                  onPress={() => setEditingNode(null)}
                >
                  <Text style={[s.btnText, { color: C.textDim }]}>CANCEL</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.btn, { backgroundColor: C.panel2, borderColor: C.mcpAccent, flex: 1, marginLeft: 6 }]}
                  onPress={handleSaveNode}
                >
                  <MaterialCommunityIcons name="check" size={14} color={C.mcpAccent} />
                  <Text style={[s.btnText, { color: C.mcpAccent }]}>SAVE</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      )}
      {/* DEPLOY NEW NODE MODAL ───────────────────────────────────────── */}
      {deployOpen && (
        <View style={s.overlay} pointerEvents="auto">
          <View style={s.sheet}>
            <View style={s.sheetHeader}>
              <Text style={s.sheetTitle}>{"// deploy new node"}</Text>
              <TouchableOpacity onPress={handleCloseDeploy}>
                <MaterialCommunityIcons name="close" size={22} color={C.green} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ paddingBottom: 20 }}>
              <Text style={[s.helperFine, { marginBottom: 10 }]}>
                Stages the bundled <Text style={{ color: C.cyan }}>enforcer-mcp.deb</Text> on
                this phone and serves it over your tailnet so a target VPS /
                Pi can {"\n"}<Text style={{ color: C.cyan }}>curl | dpkg -i</Text> it via
                one SSH command.
              </Text>

              {/* STAGE: PAYLOAD ────────────────────────────────────── */}
              <Text style={s.sectionTitle}>{"// payload"}</Text>
              <View style={s.card}>
                {deployStage === "preparing" ? (
                  <Text style={[s.helperFine, { color: C.yellow }]}>
                    ↻ staging .deb on /data/local/tmp …
                  </Text>
                ) : deployPayload ? (
                  <>
                    <Text style={s.helperFine}>
                      path: <Text style={{ color: C.cyan }}>{deployPayload.debPath}</Text>
                    </Text>
                    <Text style={[s.helperFine, { marginTop: 2 }]}>
                      size: <Text style={{ color: C.cyan }}>{(deployPayload.size / 1024).toFixed(1)} KB</Text>
                      {"  ·  "}
                      sha256: <Text style={{ color: C.cyan }}>
                        {deployPayload.sha256.slice(0, 10)}…{deployPayload.sha256.slice(-6)}
                      </Text>
                    </Text>
                    {deployPayload.sha256 === deployPayload.expectedSha256 ? (
                      <Text style={[s.helperFine, { marginTop: 4, color: C.green }]}>
                        ✓ integrity verified against bundled sidecar
                      </Text>
                    ) : (
                      <Text style={[s.helperFine, { marginTop: 4, color: C.red }]}>
                        ✗ sha mismatch — DO NOT proceed
                      </Text>
                    )}
                  </>
                ) : (
                  <Text style={[s.helperFine, { color: C.red }]}>
                    payload not staged (see error below)
                  </Text>
                )}
              </View>

              {/* STAGE: TAILNET ──────────────────────────────────── */}
              <Text style={[s.sectionTitle, { marginTop: 16 }]}>{"// tailnet"}</Text>
              <View style={s.card}>
                <Text style={s.helperFine}>
                  tailscale0 IPv4:{" "}
                  {deployTailnetIp ? (
                    <Text style={{ color: C.green }}>{deployTailnetIp}</Text>
                  ) : (
                    <Text style={{ color: C.red }}>(not detected)</Text>
                  )}
                </Text>
                <Text style={[s.helperFine, { marginTop: 6 }]}>port to serve on</Text>
                <TextInput
                  style={[s.input, { fontFamily: MONO, marginTop: 4 }]}
                  value={deployPort}
                  onChangeText={setDeployPort}
                  keyboardType="number-pad"
                  placeholder="8088"
                  placeholderTextColor={C.textDim}
                  editable={deployStage !== "serving"}
                />
                <Text style={[s.helperFine, { marginTop: 6, color: C.textDim }]}>
                  binds to {deployTailnetIp || "—"}:{deployPort || "?"} only — invisible to LAN/public.
                </Text>
              </View>

              {/* STAGE: SERVE / ONE-LINER ────────────────────────────── */}
              <Text style={[s.sectionTitle, { marginTop: 16 }]}>{"// install one-liner"}</Text>
              <View style={s.card}>
                {deployTailnetIp ? (
                  <View style={s.tokenBox}>
                    <Text style={[s.tokenText, { fontSize: 11, color: C.text }]} selectable>
                      {buildInstallOneLiner(
                        deployTailnetIp,
                        parseInt(deployPort, 10) || 8088,
                        { printToken: true },
                      )}
                    </Text>
                  </View>
                ) : (
                  <Text style={[s.helperFine, { color: C.textDim }]}>
                    waiting on tailnet IP…
                  </Text>
                )}
                <View style={[s.row, { marginTop: 10, gap: 6 }]}>
                  <TouchableOpacity
                    style={[s.btn, { flex: 1, backgroundColor: C.panel2, borderColor: C.cyan }]}
                    onPress={handleCopyOneLiner}
                    disabled={!deployTailnetIp}
                  >
                    <MaterialCommunityIcons name="content-copy" size={14} color={C.cyan} />
                    <Text style={[s.btnText, { color: C.cyan }]}>COPY ONE-LINER</Text>
                  </TouchableOpacity>
                </View>
                <Text style={[s.helperFine, { marginTop: 10, color: C.textDim }]}>
                  the last grep prints the new node&apos;s bearer token — copy that
                  into [+ ADD NODE] when you&apos;re done.
                </Text>
              </View>

              {/* STAGE: SERVER CONTROL ──────────────────────────────── */}
              <Text style={[s.sectionTitle, { marginTop: 16 }]}>{"// http server"}</Text>
              <View style={s.card}>
                <Text style={s.helperFine}>
                  status:{" "}
                  <Text style={{
                    color:
                      deployStage === "serving" ? C.green :
                      deployStage === "ready" ? C.yellow :
                      deployStage === "preparing" ? C.yellow :
                      deployStage === "stopped" ? C.textDim :
                      deployStage === "failed" ? C.red : C.textDim,
                  }}>{deployStage.toUpperCase()}</Text>
                </Text>
                <View style={[s.row, { marginTop: 10, gap: 6 }]}>
                  {deployStage !== "serving" ? (
                    <TouchableOpacity
                      style={[s.btn, { flex: 1, backgroundColor: C.panel2, borderColor: C.green }]}
                      onPress={handleStartDeployServer}
                      disabled={!deployPayload || !deployTailnetIp}
                    >
                      <MaterialCommunityIcons name="play" size={14}
                        color={(!deployPayload || !deployTailnetIp) ? C.textDim : C.green} />
                      <Text style={[s.btnText, {
                        color: (!deployPayload || !deployTailnetIp) ? C.textDim : C.green,
                      }]}>START SERVING</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={[s.btn, { flex: 1, backgroundColor: C.panel2, borderColor: C.red }]}
                      onPress={handleStopDeployServer}
                    >
                      <MaterialCommunityIcons name="stop" size={14} color={C.red} />
                      <Text style={[s.btnText, { color: C.red }]}>STOP</Text>
                    </TouchableOpacity>
                  )}
                </View>
                {deployAccessLog.length > 0 && (
                  <View style={[s.tokenBox, { marginTop: 10, maxHeight: 140 }]}>
                    <ScrollView nestedScrollEnabled>
                      {deployAccessLog.map((l, i) => (
                        <Text key={i} style={[s.helperFine, {
                          fontSize: 10, color: C.text,
                        }]} selectable>{l}</Text>
                      ))}
                    </ScrollView>
                  </View>
                )}
              </View>

              {deployError ? (
                <Text style={[s.helperFine, { marginTop: 12, color: C.red }]}>
                  err: {deployError}
                </Text>
              ) : null}

              <Text style={[s.helperFine, { marginTop: 16, color: C.textDim }]}>
                Tip: leave this modal open while the target node runs the
                one-liner — you&apos;ll see the GET request in the access log,
                confirming the download. Then tap STOP and close.
              </Text>

              <View style={[s.row, { marginTop: 16, gap: 6 }]}>
                <TouchableOpacity
                  style={[s.btn, { flex: 1, backgroundColor: C.panel2, borderColor: C.textDim }]}
                  onPress={handleCloseDeploy}
                >
                  <Text style={[s.btnText, { color: C.textDim }]}>
                    {deployStage === "serving" ? "STOP & CLOSE" : "CLOSE"}
                  </Text>
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
