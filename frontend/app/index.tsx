/* eslint-disable react/jsx-no-comment-textnodes */
// `// section` headings are an intentional, project-wide UI convention
// (e.g. "// system", "// danger zone") — they render as visible text in
// the dark terminal-style theme. The eslint rule that flags JSX children
// starting with "//" can't tell text-as-style from a stray code comment,
// so we disable it for this file only.
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
  AppState,
  ToastAndroid,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { HAS_NATIVE_ROOT, checkRoot, execReal, RootShell } from "../src/lib/rootShell";
import { sessionManager } from "../src/lib/sessionManager";
import LiveTab from "../src/components/LiveTab";
import AITab from "../src/components/AITab";
import MCPTab from "../src/components/MCPTab";
import SwatTab from "../src/components/SwatTab";
import TerminalShell from "../src/components/TerminalShell";
import WlanControl from "../src/components/WlanControl";
import SshBackendPanel, { type SshStatus } from "../src/components/SshBackendPanel";
import { setActiveBackend, execReal as backendExecReal, hasStreaming as backendHasStreaming } from "../src/lib/backend";
import {
  loadSshConfig, saveSshConfig, readSshSecrets, writeSshPassword, writeSshKey,
  type SshBackendConfig,
} from "../src/lib/sshConfig";
import {
  sshConnect, sshDisconnect, onSshState, onSshHostKey, HAS_NATIVE_SSH,
} from "../src/lib/sshBackend";
import {
  settingsLocal,
  profilesLocal,
  aiProfilesLocal,
  pcapEndpointsLocal,
  commandLogsLocal,
} from "../src/lib/localDb";
import { loadToolbarConfig, saveToolbarConfig, subscribeToolbar } from "../src/lib/toolbarStore";
import { executeSlot } from "../src/lib/toolbarActions";
import {
  HAS_OVERLAY, syncOverlayConfig, overlayHasPermission, overlayRequestPermission,
  overlayShow, overlayHide, overlayConsumePendingSlot,
} from "../src/lib/overlayControl";

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
  // AI-tab accent — kept in sync with AITab.tsx so badges/buttons feel
  // unified across the AI tab and the new Settings > AI Agents sub-tab.
  aiAccent: "#b08aff",
};

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

// ─── fetchWithRetry helper ───────────────────────────────────────────────
// Wraps `fetch` with exponential backoff retry for transient errors. The
// app's cold-boot path was previously **fatally fragile**: ONE network blip
// (Wi-Fi not associated yet, captive portal not resolved, backend service
// reloading) would cause settings GET to fail silently, leaving the UI on
// initial defaults. Then any later user toggle would PUT those defaults
// back to Mongo and clobber the real saved state. Symptoms: "exec_mode
// stuck on mock", "AI tab empty", "Live attack profiles missing".
//
// Retry policy:
//   - Network errors (TypeError) + 5xx + 429 → retry
//   - 4xx other than 408/429 → DON'T retry (it's a real client bug)
//   - Backoff: 300ms · 600ms · 1200ms · 2400ms (capped) — total ~4.5s
//
// On final failure, throws so callers can surface a visible error state
// rather than silently swallowing.
type FetchOpts = RequestInit & { retries?: number; baseDelay?: number };
async function fetchWithRetry(url: string, opts: FetchOpts = {}): Promise<Response> {
  const { retries = 4, baseDelay = 300, headers: headersIn, ...init } = opts;
  // Send browser-ish headers to dodge Cloudflare bot detection. RN's
  // default fetch sends a very minimal request that CF / proxies often
  // flag as "bot-like" → intermittent challenge pages / 4xx responses /
  // junk HTML in place of JSON. Setting a clear User-Agent + Accept
  // headers makes us look like a real app and tends to make CF's
  // heuristics relax. (`__cf_bm` cookies still need to round-trip, but
  // RN's fetch handles cookies automatically per-host.)
  const baseHeaders: Record<string, string> = {
    "User-Agent": "Enforcer/0.1 (Android; React-Native)",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
  };
  // Caller-provided headers override defaults (some endpoints set
  // Content-Type, Authorization, etc.).
  const headers = { ...baseHeaders, ...(headersIn as Record<string, string> || {}) };
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, { ...init, headers });
      if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429)) {
        return r;
      }
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries) {
      const delay = Math.min(baseDelay * Math.pow(2, attempt), 5000);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("fetchWithRetry: unknown failure");
}

// ─── fetchJSON helper ────────────────────────────────────────────────────
// Layer on top of fetchWithRetry that handles the .json() parse and, on
// failure, enriches the error with a preview of what came back. This
// surfaces silent "I got HTML when I expected JSON" cases (captive portal,
// Cloudflare challenge, Tailscale split-DNS hijack, proxy injection, etc.)
// instead of leaving the user staring at "Unexpected character p".
//
// Throws Error with .message like:
//   "HTTP 200 · text/html · body: <html><body><p>Please verify..."
async function fetchJSON<T = any>(url: string, opts: FetchOpts = {}): Promise<T> {
  const r = await fetchWithRetry(url, opts);
  const ct = r.headers.get("content-type") || "";
  // Slurp body once — we'll either JSON.parse it or include preview in error
  const text = await r.text();
  if (!r.ok) {
    const preview = text.slice(0, 120).replace(/\s+/g, " ");
    throw new Error(`HTTP ${r.status} · ${ct} · body: ${preview}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (e: any) {
    const preview = text.slice(0, 120).replace(/\s+/g, " ");
    throw new Error(`JSON parse fail · ${ct} · body: ${preview}`);
  }
}
// Lives in App-level state so // system block can render the truth.
// Each key tracks: "loading" | "ok" (with timestamp) | "error" (with msg).
// When a value is "error", a refresh button in Settings → General → //
// system lets the user force a re-fetch instead of having to kill the app.
type ResourceStatus =
  | { kind: "loading" }
  | { kind: "ok"; at: number; count?: number }
  | { kind: "error"; message: string; at: number };

type DataLoadState = {
  settings: ResourceStatus;
  profiles: ResourceStatus;
  aiProfiles: ResourceStatus;
  pcapEndpoints: ResourceStatus;
  logs: ResourceStatus;
};

const INITIAL_DATA_STATE: DataLoadState = {
  settings: { kind: "loading" },
  profiles: { kind: "loading" },
  aiProfiles: { kind: "loading" },
  pcapEndpoints: { kind: "loading" },
  logs: { kind: "loading" },
};

const BANNER = `\
 _____ _   _ _____ ___  ____   ____ _____ ____  
| ____| \\ | |  ___/ _ \\|  _ \\ / ___| ____|  _ \\ 
|  _| |  \\| | |_ | | | | |_) | |   |  _| | |_) |
| |___| |\\  |  _|| |_| |  _ <| |___| |___|  _ < 
|_____|_| \\_|_|   \\___/|_| \\_\\____|_____|_| \\_\\
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

type ExecMode = "mock" | "real" | "kali";

const NETHUNTER_CHROOT = "/data_mirror/data_ce/null/0/com.offsec.nethunter/scripts/bin/busybox_nh chroot /data/local/nhsystem/kalifs /usr/bin/sudo -E PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// Diagnostic read-only queries. The stateful controls (WiFi service,
// iface up/down, reg domain, monitor mode, channel) moved into
// <WlanControl /> as glow-dot toggles — see quick tab render. What
// remains here are pure introspection commands that get relocated to
// the Settings tab's `// diagnostics` section.
const QUICK_COMMANDS: { label: string; cmd: (c: Ctx) => string; icon: any }[] = [
  { label: "iw reg get",    cmd: () => "iw reg get",     icon: "magnify" },
  { label: "iwconfig",      cmd: () => "iwconfig",       icon: "console-line" },
  { label: "wifi status",   cmd: () => "cmd wifi status", icon: "information" },
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
  const [tab, setTab] = useState<"quick" | "terminal" | "live" | "ai" | "mcp" | "swat" | "profiles" | "settings">("quick");
  const [iface, setIface] = useState("wlan2");
  const [ifaceB, setIfaceB] = useState("");
  const [ifaceC, setIfaceC] = useState("");
  const [activeIface, setActiveIface] = useState<"A" | "B" | "C" | "ALL">("A");
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
  // When the WLAN deck's "save combo" is used, the toggle-derived command
  // sequence is stashed here so the save modal persists THAT instead of the
  // generic 12 diagnostic commands.
  const [stagedCombo, setStagedCombo] = useState<string[] | null>(null);
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileDesc, setNewProfileDesc] = useState("");
  const [execMode, setExecMode] = useState<ExecMode>("mock");
  const [bridgeRoot, setBridgeRoot] = useState<boolean | null>(null);
  const [chrootPath, setChrootPath] = useState(NETHUNTER_CHROOT);
  // ─── SSH backend mode ─────────────────────────────────────────────────────
  const [backendKind, setBackendKind] = useState<"chroot" | "ssh">("chroot");
  const [sshCfg, setSshCfg] = useState<SshBackendConfig | null>(null);
  const [sshStatus, setSshStatus] = useState<SshStatus>("down");
  const [sshStatusDetail, setSshStatusDetail] = useState("");
  const [sshSavedPw, setSshSavedPw] = useState(false);
  const [sshSavedKey, setSshSavedKey] = useState(false);
  const termRef = useRef<ScrollView>(null);

  // ─── Settings sub-tabs ───────────────────────────────────────────────────
  // The bottom tab bar was getting overcrowded (quick/term/live/ai/prof/set
  // = 6 tabs, each ~16% of screen width — too cramped on the S10+ in
  // portrait). We nested "Profiles" + "AI Agents" under Settings as
  // sub-tabs so the bottom bar shrinks to a balanced 5 tabs.
  const [settingsSubTab, setSettingsSubTab] = useState<"general" | "profiles" | "agents">("general");

  // ─── Terminal tab mode ───────────────────────────────────────────────────
  // Classic = one-shot `su -c` per command (stateless, current behavior).
  // Shell   = persistent `zsh -l` in a PTY, rendered via xterm.js so
  //           `cd`, env vars, vim, htop, command history etc. all work.
  // Stateless first-mount default = "classic" because users expect the
  // existing quick-command card flow when they tap Terminal.
  const [terminalMode, setTerminalMode] = useState<"classic" | "shell">("classic");

  // ─── AI profile editor state ─────────────────────────────────────────────
  // Inline edit sheet inside Settings > AI Agents. `aiEditing === null`
  // when the sheet is closed; an AIProfile (existing) when editing; or a
  // partial draft (no id) when creating a new one.
  const [aiProfilesList, setAiProfilesList] = useState<any[]>([]);
  const [aiEditOpen, setAiEditOpen] = useState(false);
  const [aiEditing, setAiEditing] = useState<any | null>(null);  // AIProfile | draft
  const [aiSaving, setAiSaving] = useState(false);

  // ─── PCAP endpoints state ────────────────────────────────────────────────
  // Endpoints for streaming live captures (tcpdump | nc) to remote
  // Wireshark / NetworkMiner / packet broker. Edited inline in Settings →
  // General, picked at launch time from Live tab's endpoint modal.
  const [pcapEndpointsList, setPcapEndpointsList] = useState<any[]>([]);
  const [pcapEditOpen, setPcapEditOpen] = useState(false);
  const [pcapEditing, setPcapEditing] = useState<any | null>(null);
  const [pcapSaving, setPcapSaving] = useState(false);

  // ─── Data load state — per-resource hydration tracking ──────────────────
  // Surfaced in Settings → General → // system block. Lets the user see
  // exactly which resources loaded vs. which are stuck, with a one-tap
  // "Reload" button to retry. Replaces silent fetch-failure mode that was
  // the root cause of "exec_mode stuck on mock" + "AI tab empty" etc.
  const [dataState, setDataState] = useState<DataLoadState>(INITIAL_DATA_STATE);
  const setResource = useCallback(<K extends keyof DataLoadState>(k: K, st: ResourceStatus) => {
    setDataState((prev) => ({ ...prev, [k]: st }));
  }, []);

  // ─── Floating command toolbar enable/disable ─────────────────────────────
  // The toolbar's own config (slots + position) lives in the kv store via
  // toolbarStore; here we only mirror the `enabled` flag so Settings can
  // arm/disarm the global overlay. Default is ON (see defaultConfig()).
  const [toolbarEnabled, setToolbarEnabled] = useState(true);
  const [systemOverlayOn, setSystemOverlayOn] = useState(false);
  const [overlayPerm, setOverlayPerm] = useState(false);
  useEffect(() => {
    let alive = true;
    loadToolbarConfig().then((c) => {
      if (!alive) return;
      setToolbarEnabled(c.enabled);
      setSystemOverlayOn(!!c.systemOverlay);
      syncOverlayConfig(c);
    });
    const unsub = subscribeToolbar((c) => {
      if (!alive) return;
      setToolbarEnabled(c.enabled);
      setSystemOverlayOn(!!c.systemOverlay);
      syncOverlayConfig(c);
    });
    if (HAS_OVERLAY) overlayHasPermission().then((ok) => alive && setOverlayPerm(ok));
    return () => { alive = false; unsub(); };
  }, []);
  const toggleToolbar = useCallback(async () => {
    const cur = await loadToolbarConfig();
    await saveToolbarConfig({ ...cur, enabled: !cur.enabled });
  }, []);

  // Arm/disarm the native over-other-apps overlay. Requests the "Display over
  // other apps" permission on first enable; starts/stops the foreground
  // service and pushes the resolved slot config to it.
  const toggleSystemOverlay = useCallback(async () => {
    if (!HAS_OVERLAY) {
      Alert.alert("Native build required", "The over-other-apps overlay only works in the installed APK, not Expo Go or the web preview.");
      return;
    }
    const cur = await loadToolbarConfig();
    const next = !cur.systemOverlay;
    if (next) {
      let ok = await overlayHasPermission();
      if (!ok) {
        await overlayRequestPermission();
        // User is now on the system settings screen; they'll come back and
        // re-tap. Persist intent so the AppState 'active' handler can arm it.
        Alert.alert("Grant permission", "Enable “Display over other apps” for Enforcer, then return and tap ARM again.");
        setOverlayPerm(await overlayHasPermission());
        return;
      }
      await saveToolbarConfig({ ...cur, systemOverlay: true });
      await syncOverlayConfig({ ...cur, systemOverlay: true });
      try { await overlayShow(); } catch (e: any) { Alert.alert("Overlay failed", e?.message || "could not start overlay"); }
    } else {
      await saveToolbarConfig({ ...cur, systemOverlay: false });
      await overlayHide();
    }
  }, []);

  // When a native-overlay button for an app/navigate action is tapped, the
  // service launches the app and stashes the slot id. Consume + run it here
  // (on mount and every foreground) so those actions execute in RN with full
  // DB/root context.
  useEffect(() => {
    const runPending = async () => {
      try {
        const id = await overlayConsumePendingSlot();
        if (id) {
          const cfg = await loadToolbarConfig();
          const slot = cfg.slots.find((sl) => sl.id === id);
          if (slot) {
            const res = await executeSlot(slot);
            if (Platform.OS === "android") {
              ToastAndroid.show(res.detail || (res.ok ? "ok" : "failed"), ToastAndroid.SHORT);
            }
          }
        }
        if (HAS_OVERLAY) setOverlayPerm(await overlayHasPermission());
      } catch { /* non-fatal */ }
    };
    runPending();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") runPending();
    });
    return () => sub.remove();
  }, []);


  const ctx: Ctx = { iface, country };

  // Resolve active interface(s) based on activeIface selector
  const activeIfaces = useMemo<string[]>(() => {
    const list = [iface, ifaceB, ifaceC].filter((x) => x.trim());
    if (activeIface === "ALL") return list;
    if (activeIface === "A") return [iface || "wlan0"];
    if (activeIface === "B") return [ifaceB || iface];
    return [ifaceC || iface];
  }, [iface, ifaceB, ifaceC, activeIface]);

  const primaryIface = activeIfaces[0] || iface;
  const ctxActive: Ctx = { iface: primaryIface, country };

  // Wrap a command for the current exec mode (frontend-side wrapping for kali)
  const wrapForMode = useCallback((cmd: string): string => {
    // SSH backend lands us INSIDE Kali already — no chroot prefix.
    if (backendKind === "ssh") return cmd;
    if (execMode === "kali") {
      // OffSec NetHunter wrap: bootkali's only non-interactive arbitrary-cmd interface
      // is `bootkali custom_cmd <command>`. The helper word-concats args and runs
      // `chroot $MNT sudo <cmd>`. So we just APPEND our command — no quoting/piping.
      return `${chrootPath} ${cmd}`;
    }
    return cmd;
  }, [execMode, chrootPath, backendKind]);

  // ─── SSH backend lifecycle ────────────────────────────────────────────────
  const applySshConnection = useCallback(async (cfg: SshBackendConfig) => {
    if (!HAS_NATIVE_SSH) return;
    const { password, privateKey } = await readSshSecrets();
    setSshStatus("connecting");
    setSshStatusDetail("");
    // Chroot bootstrap: if this is a NetHunter-chroot target, use the local
    // root helper to start sshd when it's down — the ONE thing SSH can't do
    // for itself (start the daemon we're about to connect to). Skips silently
    // on rootless devices (Kalidroid/remote targets leave this off).
    if (cfg.chrootBootstrap && HAS_NATIVE_ROOT) {
      setSshStatusDetail("bootstrapping sshd in chroot…");
      try {
        await execReal(
          `${chrootPath} sh -c 'pgrep -x sshd >/dev/null 2>&1 || service ssh start >/dev/null 2>&1 || /usr/sbin/sshd'`,
        );
      } catch { /* best-effort; connect attempt below will surface real errors */ }
    }
    try {
      await sshConnect({
        host: cfg.host,
        port: cfg.port,
        username: cfg.user,
        password: cfg.authMode === "password" ? password : undefined,
        privateKey: cfg.authMode === "key" ? privateKey : undefined,
      });
    } catch (e: any) {
      setSshStatus("error");
      setSshStatusDetail(e?.message || "connect failed");
    }
  }, [chrootPath]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const cfg = await loadSshConfig();
      const secrets = await readSshSecrets();
      if (!mounted) return;
      setSshCfg(cfg);
      setSshSavedPw(!!secrets.password);
      setSshSavedKey(!!secrets.privateKey);
      if (cfg.enabled && HAS_NATIVE_SSH) {
        setBackendKind("ssh");
        setActiveBackend("ssh");
        applySshConnection(cfg);
      }
    })();
    const offState = onSshState((e) => {
      if (!mounted) return;
      setSshStatus(e.state === "connected" ? "connected" : e.state === "error" ? "error" : "down");
      setSshStatusDetail(e.detail || "");
    });
    const offKey = onSshHostKey((e) => {
      if (!mounted) return;
      setSshCfg((prev) => {
        if (!prev) return prev;
        if (prev.fingerprint && prev.fingerprint !== e.fingerprint) {
          Alert.alert(
            "⚠ SSH host key changed",
            `stored: ${prev.fingerprint}\nnow:    ${e.fingerprint}\n\nIf you didn't rebuild the VM this could be a MITM. Only keep using it if you expected the change.`,
          );
          return prev;
        }
        const next = { ...prev, fingerprint: e.fingerprint }; // TOFU store-on-first-sight
        saveSshConfig(next).catch(() => {});
        return next;
      });
    });
    return () => { mounted = false; offState(); offKey(); };
  }, [applySshConnection]);

  const handleSshApply = useCallback(async (cfg: SshBackendConfig, pw: string, key: string) => {
    if (pw) { await writeSshPassword(pw); setSshSavedPw(true); }
    if (key) { await writeSshKey(key); setSshSavedKey(true); }
    await saveSshConfig(cfg);
    setSshCfg(cfg);
    if (cfg.enabled) {
      setBackendKind("ssh");
      setActiveBackend("ssh");
      await applySshConnection(cfg);
    } else {
      setBackendKind("chroot");
      setActiveBackend("chroot");
      await sshDisconnect();
      setSshStatus("down");
    }
  }, [applySshConnection]);

  const handleSshDisconnect = useCallback(async () => {
    await sshDisconnect();
    setSshStatus("down");
    setBackendKind("chroot");
    setActiveBackend("chroot");
    setSshCfg((prev) => {
      if (!prev) return prev;
      const next = { ...prev, enabled: false };
      saveSshConfig(next).catch(() => {});
      return next;
    });
  }, []);

  const fetchAll = useCallback(async () => {
    setResource("profiles", { kind: "loading" });
    setResource("logs", { kind: "loading" });
    // Logs + profiles now read straight from local SQLite. Health/root
    // info comes from the native bridge probe instead of a backend
    // round-trip. No network = no flakes.
    try {
      const logs = await commandLogsLocal.list(200);
      historicalCountRef.current = logs.length;
      setLogs(logs);
      setResource("logs", { kind: "ok", at: Date.now(), count: logs.length });
    } catch (e: any) {
      setResource("logs", { kind: "error", message: e?.message || "sqlite read failed", at: Date.now() });
    }
    try {
      const pf = await profilesLocal.list();
      setProfiles(pf);
      setResource("profiles", { kind: "ok", at: Date.now(), count: pf.length });
    } catch (e: any) {
      setResource("profiles", { kind: "error", message: e?.message || "sqlite read failed", at: Date.now() });
    }
  }, [setResource]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ─── AI profile CRUD ──────────────────────────────────────────────────
  // Fetches/creates/updates/deletes AIProfile docs. Lives at the App level
  // so both the AI tab (chip selector, used by AITab.tsx) and the new
  // Settings > AI Agents sub-tab can share a single source of truth.
  // We keep AITab's internal fetch too — they de-dupe via the backend.
  const fetchAIProfiles = useCallback(async () => {
    setResource("aiProfiles", { kind: "loading" });
    try {
      const data = await aiProfilesLocal.list();
      setAiProfilesList(data);
      setResource("aiProfiles", { kind: "ok", at: Date.now(), count: data.length });
    } catch (e: any) {
      setResource("aiProfiles", { kind: "error", message: e?.message || "sqlite read failed", at: Date.now() });
    }
  }, [setResource]);

  useEffect(() => { fetchAIProfiles(); }, [fetchAIProfiles]);

  /** Open the editor sheet — pass null for "new", or an existing profile for "edit". */
  const openAIEditor = useCallback((p: any | null) => {
    setAiEditing(
      p
        ? { ...p }
        : {
            // sensible defaults for new agents — match the seed profile defaults
            name: "",
            command: "",
            description: "",
            wrap_mode: "none",
            view_mode: "xterm",
            send_newline: true,
            send_initial: null,
            pre_command: null,
            icon: "🤖",
          },
    );
    setAiEditOpen(true);
  }, []);

  const closeAIEditor = useCallback(() => {
    setAiEditOpen(false);
    // Defer clearing so the sheet fade-out doesn't show empty fields.
    setTimeout(() => setAiEditing(null), 200);
  }, []);

  const saveAIProfile = useCallback(async () => {
    if (!aiEditing) return;
    const name = (aiEditing.name || "").trim();
    const command = (aiEditing.command || "").trim();
    if (!name || !command) {
      Alert.alert("Required fields", "Both name and command are required.");
      return;
    }
    setAiSaving(true);
    try {
      // Null-out empty optional strings so pre_command empty-string can't
      // get joined with `&&` and break the launcher shell.
      const payload: any = {
        id: aiEditing.id,
        name,
        command,
        description: aiEditing.description || "",
        wrap_mode: aiEditing.wrap_mode || "none",
        view_mode: aiEditing.view_mode || "xterm",
        send_newline: aiEditing.send_newline !== false,
        send_initial: aiEditing.send_initial && aiEditing.send_initial.trim() ? aiEditing.send_initial.trim() : null,
        pre_command: aiEditing.pre_command && aiEditing.pre_command.trim() ? aiEditing.pre_command.trim() : null,
        icon: aiEditing.icon || "🤖",
      };
      await aiProfilesLocal.upsert(payload);
      await fetchAIProfiles();
      closeAIEditor();
    } catch (e: any) {
      Alert.alert("Save failed", e?.message || "Unknown error");
    } finally {
      setAiSaving(false);
    }
  }, [aiEditing, fetchAIProfiles, closeAIEditor]);

  const deleteAIProfile = useCallback(async (id: string, name: string) => {
    Alert.alert(
      "Delete agent?",
      `Permanently remove "${name}"? This won't touch any running session.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await aiProfilesLocal.delete(id);
              await fetchAIProfiles();
            } catch (e: any) {
              Alert.alert("Delete failed", e?.message || "sqlite error");
            }
          },
        },
      ],
    );
  }, [fetchAIProfiles]);

  // ─── PCAP endpoint CRUD ───────────────────────────────────────────────
  // Pattern mirrors AI profile CRUD exactly — same idempotent fetch +
  // open/close/save flow + delete-with-confirm. We could DRY these into a
  // generic <CrudEditor /> helper later, but explicit copies are easier to
  // tweak per-resource (PCAP endpoint forms need port validation, etc).
  const fetchPcapEndpoints = useCallback(async () => {
    setResource("pcapEndpoints", { kind: "loading" });
    try {
      const data = await pcapEndpointsLocal.list();
      setPcapEndpointsList(data);
      setResource("pcapEndpoints", { kind: "ok", at: Date.now(), count: data.length });
    } catch (e: any) {
      setResource("pcapEndpoints", { kind: "error", message: e?.message || "sqlite read failed", at: Date.now() });
    }
  }, [setResource]);

  // ─── API ping diagnostic ────────────────────────────────────────────────
  // Single-shot connectivity probe surfaced in Settings → // data status.
  // Shows: HTTP code, content-type, response time, body preview. Handy for
  // the multi-route scenario (Wi-Fi + mobile data + Tailscale) where one
  // path gets hijacked by a captive portal / Cloudflare challenge / split
  // DNS and returns junk that breaks the app silently.
  const [apiPing, setApiPing] = useState<string>("");
  const pingApi = useCallback(async () => {
    setApiPing("pinging…");
    const t0 = Date.now();
    try {
      const r = await fetch(`${API}/health`);
      const dt = Date.now() - t0;
      const ct = r.headers.get("content-type") || "?";
      const text = await r.text();
      const preview = text.slice(0, 80).replace(/\s+/g, " ");
      setApiPing(`HTTP ${r.status} · ${dt}ms · ${ct} · ${preview}`);
    } catch (e: any) {
      const dt = Date.now() - t0;
      setApiPing(`FAILED · ${dt}ms · ${e?.message || "network error"}`);
    }
  }, []);

  useEffect(() => { fetchPcapEndpoints(); }, [fetchPcapEndpoints]);

  const openPcapEditor = useCallback((e: any | null) => {
    setPcapEditing(
      e
        ? { ...e }
        : { name: "", host: "", port: 19000, transport: "tcp", notes: "" },
    );
    setPcapEditOpen(true);
  }, []);

  const closePcapEditor = useCallback(() => {
    setPcapEditOpen(false);
    setTimeout(() => setPcapEditing(null), 200);
  }, []);

  const savePcapEndpoint = useCallback(async () => {
    if (!pcapEditing) return;
    const name = (pcapEditing.name || "").trim();
    const host = (pcapEditing.host || "").trim();
    const port = Number(pcapEditing.port);
    if (!name || !host) {
      Alert.alert("Required fields", "Name and host are required.");
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      Alert.alert("Invalid port", "Port must be 1..65535.");
      return;
    }
    setPcapSaving(true);
    try {
      await pcapEndpointsLocal.upsert({
        id: pcapEditing.id,
        name, host, port,
        transport: pcapEditing.transport || "tcp",
        notes: pcapEditing.notes || "",
      });
      await fetchPcapEndpoints();
      closePcapEditor();
    } catch (e: any) {
      Alert.alert("Save failed", e?.message || "Unknown error");
    } finally {
      setPcapSaving(false);
    }
  }, [pcapEditing, fetchPcapEndpoints, closePcapEditor]);

  const deletePcapEndpoint = useCallback((id: string, name: string) => {
    Alert.alert(
      "Delete endpoint?",
      `Remove "${name}"? Running PCAP streams to this endpoint won't be affected.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await pcapEndpointsLocal.delete(id);
              await fetchPcapEndpoints();
            } catch (e: any) {
              Alert.alert("Delete failed", e?.message || "sqlite error");
            }
          },
        },
      ],
    );
  }, [fetchPcapEndpoints]);

  // Initialize streaming session manager with backend API base
  useEffect(() => { sessionManager.configure(API); }, []);

  // Detect native bridge & root status (only present in built APK; null in Expo Go/web).
  // Also seeds rootInfo locally — previously this came from /api/health
  // which is exactly the kind of "cold-boot network flake → blank UI" we
  // killed by going local-first.
  useEffect(() => {
    // Always set baseline so // system block isn't perpetually "..."
    setRootInfo({
      device: Platform.OS === "android" ? "android" : Platform.OS,
      android_version: String(Platform.Version),
      root_granted: bridgeRoot === true,
    });
    if (!HAS_NATIVE_ROOT) return;
    checkRoot()
      .then((ok) => {
        setBridgeRoot(ok);
        setRootInfo((prev: any) => ({ ...(prev || {}), root_granted: ok }));
      })
      .catch(() => setBridgeRoot(false));
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // Note: We *don't* auto-force back to mock if HAS_NATIVE_ROOT is false.
  // HAS_NATIVE_ROOT is a snapshot at module-import time and can race the
  // RN bridge — falsely reporting "no native" while the bridge is actually
  // working a few ms later. Forcing mock here used to clobber the user's
  // saved KALI/REAL preference at every cold start. Now we trust the saved
  // setting and let runtime calls fail loudly if the bridge is truly absent.

  // Settings persistence — fixed write-before-read race:
  // Previously the PUT useEffect would fire on mount with initial state ("mock"
  // for execMode and defaultExecMode), and on a slow fetch it would land BEFORE
  // the GET resolved — overwriting the user's saved preference in MongoDB.
  // Symptom: user toggles to KALI, force-closes app, reopens → back to MOCK.
  // Fix: gate the PUT on a `settingsLoaded` ref that flips true only after the
  // initial GET resolves (success OR error — we don't want to block writes forever).
  const settingsLoaded = useRef(false);
  // Tracks how many log entries were already historical at the moment the app
  // last fetched from the backend. Anything in the `logs` array at an index
  // below this value is "from a previous session" and gets visually dimmed +
  // sits above a divider. New entries (appended during this session) render
  // at full brightness below the divider.
  const historicalCountRef = useRef<number>(0);

  // Settings GET extracted into its own callback so the // data status
  // "reload" button can re-run it manually if the initial load failed.
  // Settings GET — now reads from SQLite instead of /api/settings. Falls
  // back to defaults on first run (sqlite empty). No network involvement
  // means no retry, no cloudflare flakes, no "mock stickiness". Settings
  // are simply *always* available, instantly. The reload button still
  // works for symmetry (re-reads from sqlite — useful if another part
  // of the app updated settings).
  const reloadSettings = useCallback(async () => {
    setResource("settings", { kind: "loading" });
    try {
      const s = await settingsLocal.get();
      console.log(`[settings] localDb → exec_mode=${s.exec_mode} iface_a=${s.iface_a}`);
      setIface(s.iface_a);
      setIfaceB(s.iface_b);
      setIfaceC(s.iface_c);
      setCountry(s.country);
      setActiveIface(s.active_iface as "A" | "B" | "C" | "ALL");
      if (s.chroot_path) {
        const legacy = [
          "bootkali", "bootkali_login", "bootkali_bash",
          "bootkali custom_cmd", "nethunter", "nh", "echo | bootkali",
        ];
        const v = s.chroot_path.trim();
        setChrootPath(legacy.includes(v) ? NETHUNTER_CHROOT : v);
      }
      setExecMode(s.exec_mode);
      settingsLoaded.current = true;
      setResource("settings", { kind: "ok", at: Date.now() });
    } catch (e: any) {
      console.error("[settings] localDb read failed:", e?.message);
      setResource("settings", { kind: "error", message: e?.message || "sqlite read failed", at: Date.now() });
    }
  }, [setResource]);

  useEffect(() => { reloadSettings(); }, [reloadSettings]);

  // ─── Refresh on app foreground ────────────────────────────────────────
  // When the user backgrounds the app (locks phone, switches to another
  // app) and comes back, re-run all GETs. Catches the case where Wi-Fi
  // got dropped/changed in the meantime AND the cold-boot equivalent for
  // long-suspended apps. Also catches transient backend restarts that
  // happened while the app was in the background.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        // eslint-disable-next-line no-console
        console.log("[appstate] active — refreshing data");
        reloadSettings();
        fetchAll();
        fetchAIProfiles();
        fetchPcapEndpoints();
      }
    });
    return () => sub.remove();
  }, [reloadSettings, fetchAll, fetchAIProfiles, fetchPcapEndpoints]);

  // Save on change — writes to local SQLite. No network, no race condition,
  // no possibility of stale fetch clobbering. Settings persist instantly
  // and reliably across cold boots, airplane mode, network changes — full
  // stop. The `settingsLoaded` gate is retained so the very first render
  // pass (before reloadSettings completes) doesn't trample defaults onto
  // existing sqlite data.
  useEffect(() => {
    if (!settingsLoaded.current) return;
    const t = setTimeout(() => {
      settingsLocal.update({
        exec_mode: execMode,
        iface_a: iface,
        iface_b: ifaceB,
        iface_c: ifaceC,
        country,
        active_iface: activeIface,
        chroot_path: chrootPath,
      }).catch((e) => {
        console.warn("[settings] localDb update failed:", e?.message);
      });
    }, 500);
    return () => clearTimeout(t);
  }, [execMode, iface, ifaceB, ifaceC, country, activeIface, chrootPath]);

  useEffect(() => {
    if (tab !== "terminal") return;
    const t = setTimeout(() => termRef.current?.scrollToEnd({ animated: true }), 80);
    return () => clearTimeout(t);
  }, [logs, tab]);

  // Substitute $IFACE in a command for a specific iface (when fanning out to ALL)
  const substIface = (cmd: string, ifname: string) =>
    cmd.replace(new RegExp(`\\b${iface}\\b`, "g"), ifname);

  const execute = useCallback(async (command: string) => {
    if (!command.trim() || running) return;
    setRunning(true);
    const sshActive = backendKind === "ssh";
    // Real exec is possible when SSH backend is live (rootless Kalidroid, etc.)
    // OR when a local root bridge is present in real/kali mode. Quick-scans now
    // route through the backend selector so they work over SSH too.
    const isReal = sshActive
      ? (HAS_NATIVE_SSH && backendHasStreaming())
      : ((execMode === "real" || execMode === "kali") && HAS_NATIVE_ROOT);
    // Fan out across all active ifaces if ALL is selected
    const targets = activeIface === "ALL" ? activeIfaces : [primaryIface];
    try {
      for (const ifname of targets) {
        const cmd = targets.length > 1 ? substIface(command, ifname) : command;
        const wrapped = wrapForMode(cmd);
        let newLog: Log;
        if (isReal) {
          const t0 = Date.now();
          // backendExecReal routes to SSH or su→chroot per active backend.
          const r = await backendExecReal(wrapped);
          newLog = {
            id: String(Date.now()) + Math.random(),
            timestamp: new Date().toISOString(),
            command: cmd,
            output: r.output,
            exit_code: r.exit_code,
            duration_ms: r.duration_ms || (Date.now() - t0),
            mocked: false,
          };
        } else {
          // Local "preview" exec — synthesizes a mock result without any
          // backend round-trip. Keeps the UI working in Expo Go / web /
          // air-gapped sessions when no native bridge is present.
          newLog = {
            id: String(Date.now()) + Math.random(),
            timestamp: new Date().toISOString(),
            command: cmd,
            output: `[preview] ${cmd}\n(no live backend — switch to KALI/REAL after installing APK, or enable SSH backend in Settings)`,
            exit_code: 0,
            duration_ms: 0,
            mocked: true,
          };
        }
        setLogs((p) => [...p, newLog]);
        commandLogsLocal.append(newLog).catch((e) =>
          console.warn("[logs] sqlite append failed:", e?.message));
      }
    } catch (e: any) {
      const errLog: Log = {
        id: String(Date.now()), command, output: `[err] ${e?.message || e}`,
        exit_code: 1, duration_ms: 0, mocked: execMode === "mock", timestamp: new Date().toISOString(),
      };
      setLogs((p) => [...p, errLog]);
      commandLogsLocal.append(errLog).catch(() => {});
    } finally { setRunning(false); }
  }, [running, execMode, activeIface, activeIfaces, primaryIface, iface, wrapForMode, backendKind]);

  const runProfile = useCallback(async (p: Profile) => {
    setRunning(true);
    const sshActive = backendKind === "ssh";
    const isReal = sshActive
      ? (HAS_NATIVE_SSH && backendHasStreaming())
      : ((execMode === "real" || execMode === "kali") && HAS_NATIVE_ROOT);
    const targets = activeIface === "ALL" ? activeIfaces : [primaryIface];
    try {
      const newLogs: Log[] = [];
      if (isReal && sshActive) {
        // SSH backend has no batch primitive — run each command sequentially
        // through the selector's one-shot exec. wrapForMode returns the raw
        // command for SSH (we're already inside Kali), so no chroot prefix.
        for (const ifname of targets) {
          for (const c of p.commands) {
            const subbed = targets.length > 1 ? substIface(c, ifname) : c;
            const t0 = Date.now();
            const r = await backendExecReal(wrapForMode(subbed));
            newLogs.push({
              id: String(Date.now()) + Math.random(),
              command: subbed,
              output: r.output,
              exit_code: r.exit_code,
              duration_ms: r.duration_ms || (Date.now() - t0),
              mocked: false,
              timestamp: new Date().toISOString(),
            });
          }
        }
      } else if (isReal && RootShell) {
        // Fan out commands across target ifaces, all wrapped for chroot if needed
        const flatCmds: { display: string; wrapped: string }[] = [];
        for (const ifname of targets) {
          for (const c of p.commands) {
            const subbed = targets.length > 1 ? substIface(c, ifname) : c;
            flatCmds.push({ display: subbed, wrapped: wrapForMode(subbed) });
          }
        }
        const data = await RootShell.execBatch(flatCmds.map((x) => x.wrapped));
        data.logs.forEach((l: any, i: number) => {
          newLogs.push({
            id: String(Date.now()) + Math.random() + i,
            command: flatCmds[i]?.display || l.command,
            output: l.stdout || l.stderr || "",
            exit_code: l.exit_code,
            duration_ms: 0,
            mocked: false,
            timestamp: new Date().toISOString(),
          });
        });
      } else {
        // Local preview — synthesize an entry per command, no backend.
        for (const ifname of targets) {
          for (const c of p.commands) {
            const subbed = targets.length > 1 ? substIface(c, ifname) : c;
            newLogs.push({
              id: String(Date.now()) + Math.random(),
              command: subbed,
              output: `[preview] ${subbed}`,
              exit_code: 0,
              duration_ms: 0,
              mocked: true,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
      setLogs((prev) => [...prev, ...newLogs]);
      for (const l of newLogs) {
        commandLogsLocal.append(l).catch(() => {});
      }
      // Land on the classic terminal view so output is immediately visible —
      // shell sub-tab would swallow these one-shot logs silently.
      setTerminalMode("classic");
      setTab("terminal");
    } catch (e) { console.warn(e); }
    finally { setRunning(false); }
  }, [execMode, activeIface, activeIfaces, primaryIface, iface, wrapForMode, backendKind]);

  const deleteProfile = useCallback(async (id: string) => {
    await profilesLocal.delete(id);
    fetchAll();
  }, [fetchAll]);

  const clearLogs = useCallback(async () => {
    await commandLogsLocal.clear();
    historicalCountRef.current = 0;
    setLogs([]);
  }, []);

  const saveCurrentAsProfile = useCallback(async () => {
    if (!newProfileName.trim()) { Alert.alert("Name required"); return; }
    const cmds = stagedCombo ?? QUICK_COMMANDS.map((q) => q.cmd(ctxActive));
    await profilesLocal.create({
      name: newProfileName.trim(),
      description: newProfileDesc.trim(),
      commands: cmds,
    });
    setSaveOpen(false); setNewProfileName(""); setNewProfileDesc(""); setStagedCombo(null); fetchAll();
  }, [newProfileName, newProfileDesc, ctxActive, stagedCombo, fetchAll]);

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
        await profilesLocal.create({
          name: String(p.name),
          description: String(p.description || ""),
          commands: p.commands.map(String),
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
          <Text style={s.fieldLabel}>$IFACE_A</Text>
          <TextInput testID="input-iface-a" value={iface} onChangeText={setIface}
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
      <View style={{ flexDirection: "row", marginTop: 8 }}>
        <View style={[s.field, { flex: 1, marginRight: 10 }]}>
          <Text style={s.fieldLabel}>$IFACE_B <Text style={{ color: C.textDim }}>(optional)</Text></Text>
          <TextInput testID="input-iface-b" value={ifaceB} onChangeText={setIfaceB}
            style={s.fieldInput} placeholder="wlan3" placeholderTextColor={C.textDim}
            autoCapitalize="none" autoCorrect={false} />
        </View>
        <View style={[s.field, { flex: 1 }]}>
          <Text style={s.fieldLabel}>$IFACE_C <Text style={{ color: C.textDim }}>(optional)</Text></Text>
          <TextInput testID="input-iface-c" value={ifaceC} onChangeText={setIfaceC}
            style={s.fieldInput} placeholder="wlan4" placeholderTextColor={C.textDim}
            autoCapitalize="none" autoCorrect={false} />
        </View>
      </View>

      {/* Active adapter chip selector */}
      <View style={{ marginTop: 12 }}>
        <Text style={s.fieldLabel}>active adapter</Text>
        <View style={s.chipRow}>
          {(["A", "B", "C", "ALL"] as const).map((k) => {
            const enabled = k === "A" || (k === "B" && ifaceB) || (k === "C" && ifaceC) ||
                            (k === "ALL" && (ifaceB || ifaceC));
            const active = activeIface === k;
            return (
              <TouchableOpacity
                key={k}
                testID={`chip-${k}`}
                disabled={!enabled}
                onPress={() => setActiveIface(k)}
                style={[
                  s.chip,
                  active && { backgroundColor: C.green, borderColor: C.green },
                  !enabled && { opacity: 0.3 },
                ]}
              >
                <Text style={[s.chipText, active && { color: C.bg, fontWeight: "800" }]}>{k}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {activeIface === "ALL" && activeIfaces.length > 1 && (
          <Text style={[s.helper, { marginTop: 6 }]}>
            quick actions will run on: <Text style={{ color: C.cyan }}>{activeIfaces.join(", ")}</Text>
          </Text>
        )}
      </View>

      <View style={[s.sectionRow, { marginTop: 24 }]}>
        <Text style={s.sectionTitle}>// wlan control</Text>
        <TouchableOpacity testID="btn-save-profile" onPress={() => setSaveOpen(true)} style={s.smallBtn}>
          <Ionicons name="bookmark-outline" size={12} color={C.green} />
          <Text style={s.smallBtnText}>save as profile</Text>
        </TouchableOpacity>
      </View>

      <WlanControl
        iface={primaryIface}
        country={country}
        onIfaceChange={(i) => setIface(i)}
        disabled={running}
        onSaveCombo={(cmds) => {
          setStagedCombo(cmds);
          setNewProfileName("");
          setNewProfileDesc("");
          setSaveOpen(true);
        }}
        onExecCommand={async (cmd) => {
          // Reuse the existing exec pipeline so command_logs, exec_mode
          // wrapping, and the terminal jump-to-classic behavior all still
          // apply. `wrap` is out of scope here (it's a closure in
          // renderQuick's parent) — we invoke `execute` directly.
          execute(cmd);
          setTerminalMode("classic");
          setTab("terminal");
        }}
      />
    </ScrollView>
  );

  const renderTerminal = () => (
    <View style={{ flex: 1 }}>
      {/* Mode toggle — classic (one-shot cards) vs shell (persistent zsh).
          Defaults to classic so we don't break the existing quick-command
          flow. Shell mode requires REAL or KALI execMode (won't work in
          mock since there's no real shell to keep alive). */}
      <View style={s.subTabBar}>
        {(["classic", "shell"] as const).map((m) => {
          const active = terminalMode === m;
          const label = m === "classic" ? `Host · ${logs.length}` : "Kali · zsh";
          const icon: any = m === "classic" ? "android" : "linux";
          return (
            <TouchableOpacity
              key={m}
              testID={`term-mode-${m}`}
              onPress={() => setTerminalMode(m)}
              style={[s.subTab, active && s.subTabActive]}
            >
              <MaterialCommunityIcons name={icon} size={14} color={active ? C.green : C.textDim} />
              <Text style={[s.subTabText, active && { color: C.green }]}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {terminalMode === "shell" ? (
        <TerminalShell
          execMode={backendKind === "ssh" ? "kali" : execMode}
          wrap={wrapForMode}
          sshMode={backendKind === "ssh"}
        />
      ) : (
        <>
          <ScrollView ref={termRef} style={{ flex: 1, backgroundColor: "#02050a" }}
            contentContainerStyle={{ padding: 12, paddingBottom: 24 }}>
            <Text style={s.banner}>{BANNER}</Text>
            <Text style={s.bannerSub}>
              {`# session: ${rootInfo?.device || "..."} · ${rootInfo?.android_version || "..."}\n# entries: ${logs.length} · status: ${running ? "BUSY" : "idle"}\n`}
            </Text>
            {logs.map((l, idx) => {
              const isHistorical = idx < historicalCountRef.current;
              const isFirstCurrent = idx === historicalCountRef.current && historicalCountRef.current > 0;
              return (
                <React.Fragment key={l.id}>
                  {isFirstCurrent && (
                    <View style={{ flexDirection: "row", alignItems: "center", marginVertical: 8 }}>
                      <View style={{ flex: 1, height: 1, backgroundColor: C.textDim, opacity: 0.4 }} />
                      <Text style={{ color: C.cyan, fontFamily: MONO, fontSize: 10, marginHorizontal: 8, letterSpacing: 1 }}>
                        ── CURRENT SESSION ──
                      </Text>
                      <View style={{ flex: 1, height: 1, backgroundColor: C.textDim, opacity: 0.4 }} />
                    </View>
                  )}
                  <View style={{ marginBottom: 10, opacity: isHistorical ? 0.45 : 1 }}>
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
                </React.Fragment>
              );
            })}
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
        </>
      )}
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
    <View style={{ flex: 1 }}>
      {/* Sub-tab bar — nested navigation inside Settings. We use a small
          segmented control rather than the bottom tab bar to keep the
          main bar simple. Profiles + AI Agents previously lived as
          top-level tabs but the bar was getting overcrowded. */}
      <View style={s.subTabBar}>
        {(["general", "profiles", "agents"] as const).map((sub) => {
          const active = settingsSubTab === sub;
          const label = sub === "general" ? "general" : sub === "profiles" ? `profiles · ${profiles.length}` : `agents · ${aiProfilesList.length}`;
          const icon: any = sub === "general" ? "cog" : sub === "profiles" ? "bookmark-multiple" : "robot-outline";
          return (
            <TouchableOpacity
              key={sub}
              testID={`settings-subtab-${sub}`}
              onPress={() => setSettingsSubTab(sub)}
              style={[s.subTab, active && s.subTabActive]}
            >
              <MaterialCommunityIcons name={icon} size={14} color={active ? C.green : C.textDim} />
              <Text style={[s.subTabText, active && { color: C.green }]}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {settingsSubTab === "profiles" ? renderProfiles()
        : settingsSubTab === "agents" ? renderAIProfiles()
        : renderGeneralSettings()}
    </View>
  );

  const renderGeneralSettings = () => (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
      <Text style={s.sectionTitle}>// system</Text>
      <View style={s.kvBlock}>
        <KV k="exec mode" v={execMode === "kali" ? "KALI · chroot" : execMode === "real" ? "ANDROID · su -c" : "PREVIEW"} vColor={execMode === "mock" ? C.yellow : C.green} />
        <KV k="bridge" v={HAS_NATIVE_ROOT ? (bridgeRoot ? "loaded · root granted" : bridgeRoot === false ? "loaded · root denied" : "loaded · checking…") : "absent (Expo Go / web)"} vColor={HAS_NATIVE_ROOT ? (bridgeRoot ? C.green : C.red) : C.textDim} />
        <KV k="root" v={rootInfo?.root_granted ? "GRANTED" : "..."} vColor={rootInfo?.root_granted ? C.green : C.red} />
        <KV k="device" v={rootInfo?.device || "..."} vColor={C.cyan} />
        <KV k="os" v={rootInfo?.android_version || "..."} vColor={C.cyan} />
        <KV k="active iface" v={activeIface === "ALL" ? `ALL (${activeIfaces.join(", ")})` : `${activeIface} · ${primaryIface}`} vColor={C.cyan} />
      </View>

      {/* ─── Floating command toolbar arm/disarm. The global SDR-style
          overlay defaults ON; operators who don't want the HUD can stow
          it here. Tapping opens no editor — just flips enabled; per-slot
          config lives in the toolbar's own CONFIG gear. ─── */}
      <Text style={[s.sectionTitle, { marginTop: 18 }]}>{"// command overlay"}</Text>
      <TouchableOpacity
        testID="btn-toolbar-toggle"
        onPress={toggleToolbar}
        style={s.row}
        activeOpacity={0.7}
      >
        <MaterialCommunityIcons
          name={toolbarEnabled ? "toggle-switch" : "toggle-switch-off-outline"}
          size={22}
          color={toolbarEnabled ? C.green : C.textDim}
        />
        <Text style={[s.rowText, { color: toolbarEnabled ? C.green : C.textDim }]}>
          floating toolbar {toolbarEnabled ? "ARMED" : "OFF"}
        </Text>
        <MaterialCommunityIcons name="radar" size={16} color={toolbarEnabled ? C.green : C.textDim} />
      </TouchableOpacity>
      <Text style={s.helper}>
        draggable HUD for quick MCP/app actions · tap its gear to edit buttons.
      </Text>

      {/* ─── Over-other-apps system overlay. This is the *native* floating
          bubble that stays visible on top of OTHER apps (foreground service +
          "Display over other apps" permission). MCP-tool buttons fire silently
          over HTTP; app actions bring Enforcer forward. Only works in the
          installed APK. ─── */}
      <TouchableOpacity
        testID="btn-system-overlay-toggle"
        onPress={toggleSystemOverlay}
        style={[s.row, { marginTop: 8, borderColor: systemOverlayOn ? C.green : C.border }]}
        activeOpacity={0.7}
      >
        <MaterialCommunityIcons
          name={systemOverlayOn ? "toggle-switch" : "toggle-switch-off-outline"}
          size={22}
          color={systemOverlayOn ? C.green : C.textDim}
        />
        <Text style={[s.rowText, { color: systemOverlayOn ? C.green : C.textDim }]}>
          over other apps {systemOverlayOn ? "ARMED" : "OFF"}
        </Text>
        <MaterialCommunityIcons name="picture-in-picture-bottom-right" size={16} color={systemOverlayOn ? C.green : C.textDim} />
      </TouchableOpacity>
      {!HAS_OVERLAY ? (
        <Text style={[s.helper, { color: C.yellow }]}>
          ⚠ installed APK only — not Expo Go / web preview.
        </Text>
      ) : (
        <Text style={s.helper}>
          floats over every app · perm:{" "}
          <Text style={{ color: overlayPerm ? C.green : C.red }}>
            {overlayPerm ? "granted" : "not granted"}
          </Text>
        </Text>
      )}


      {/* ─── Data load status — visibility into the previously-silent
          fetch-failure mode that caused "exec_mode stuck on mock" + "AI
          tab empty" etc. Each row shows OK/loading/error + a count or
          last-error message. Tap "reload" to force a re-fetch of
          everything (settings, profiles, ai-profiles, attack-profiles,
          pcap-endpoints). ─── */}
      <View style={[s.sectionRow, { marginTop: 14 }]}>
        <Text style={s.sectionTitle}>// data status</Text>
        <View style={{ flexDirection: "row", gap: 6 }}>
          <TouchableOpacity testID="btn-ping-api" onPress={pingApi} style={s.smallBtn}>
            <MaterialCommunityIcons name="lan-pending" size={14} color={C.cyan} />
            <Text style={[s.smallBtnText, { color: C.cyan }]}>ping</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="btn-reload-data"
            onPress={() => { reloadSettings(); fetchAll(); fetchAIProfiles(); fetchPcapEndpoints(); }}
            style={s.smallBtn}
          >
            <Ionicons name="refresh" size={14} color={C.green} />
            <Text style={[s.smallBtnText, { color: C.green }]}>reload</Text>
          </TouchableOpacity>
        </View>
      </View>
      {!!apiPing && (
        <View style={[s.kvBlock, { marginBottom: 6 }]}>
          <Text style={[s.helper, { fontFamily: MONO, color: apiPing.startsWith("HTTP 2") ? C.green : C.yellow }]} selectable>
            ping → {apiPing}
          </Text>
        </View>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
        {(["settings", "logs", "profiles", "aiProfiles", "pcapEndpoints"] as const).map((key) => {
          const st = dataState[key];
          const kw =
            key === "settings" ? "cfg" :
            key === "logs" ? "logs" :
            key === "profiles" ? "prof" :
            key === "aiProfiles" ? "agents" : "pcap";
          let dot: string; let count: string;
          if (st.kind === "loading") { dot = C.yellow; count = "…"; }
          else if (st.kind === "ok") { dot = C.green; count = st.count !== undefined ? String(st.count) : "✓"; }
          else { dot = C.red; count = "!"; }
          return (
            <View
              key={key}
              testID={`data-bulb-${key}`}
              style={{
                flexDirection: "row", alignItems: "center",
                borderWidth: 1, borderColor: C.border, borderRadius: 3,
                paddingHorizontal: 7, paddingVertical: 4, backgroundColor: C.panel,
              }}
            >
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: dot, marginRight: 5 }} />
              <Text style={{ fontFamily: MONO, fontSize: 10, color: C.textDim }}>{kw} </Text>
              <Text style={{ fontFamily: MONO, fontSize: 10, color: dot }}>{count}</Text>
            </View>
          );
        })}
      </View>
      {!settingsLoaded.current && dataState.settings.kind === "error" && (
        <Text style={[s.helper, { color: C.red, marginTop: 6 }]}>
          ⚠ settings not loaded — writes BLOCKED. tap reload to retry.
        </Text>
      )}

      <Text style={[s.sectionTitle, { marginTop: 24 }]}>// execution mode</Text>
      <View style={s.segGroup}>
        {(["mock", "real", "kali"] as ExecMode[]).map((m) => {
          const active = execMode === m;
          const disabled = m !== "mock" && !HAS_NATIVE_ROOT;
          // Hide "Preview" once the native bridge is confirmed present —
          // it becomes a silent auto-fallback for Expo Go / web preview
          // / cold boots before checkRoot() resolves. Operators on a real
          // build never need to see a "MOCK" button cluttering the UI.
          if (m === "mock" && HAS_NATIVE_ROOT && bridgeRoot === true) return null;
          const color = m === "mock" ? C.yellow : m === "real" ? C.green : C.magenta;
          // Operator-brain labels: mock → Preview (auto-fallback),
          // real → Android (raw su -c), kali → Kali (chroot wrap).
          const label = m === "mock" ? "PREVIEW" : m === "real" ? "ANDROID" : "KALI";
          return (
            <TouchableOpacity
              key={m}
              testID={`btn-mode-${m}`}
              onPress={() => {
                if (disabled) {
                  Alert.alert("Bridge not present", "Build the APK first. See /app/root-bridge/README.md.");
                  return;
                }
                // Only block if root has been EXPLICITLY checked and denied.
                // `bridgeRoot === null` means the async checkRoot() probe hasn't
                // resolved yet — historically we bailed here, which silently
                // dropped KALI taps during the first ~hundred ms of cold boot
                // and was the root cause of "MOCK keeps sticking on reopen".
                // Now we proceed optimistically; if root is truly absent, the
                // actual command exec will fail loudly with a useful error.
                if (m !== "mock" && bridgeRoot === false) {
                  Alert.alert("Root not granted", "Open Magisk and grant root for WiFi Enforcer, then try again.");
                  return;
                }
                // If still probing, kick off a background re-check so the UI
                // catches up to reality without blocking this tap.
                if (m !== "mock" && bridgeRoot === null && HAS_NATIVE_ROOT) {
                  checkRoot().then(setBridgeRoot).catch(() => setBridgeRoot(false));
                }
                setExecMode(m);
                // Fire-and-forget IMMEDIATE local SQLite write — bypasses
                // the debounced useEffect so the mode change is durably
                // persisted even if the user instantly kills the app. The
                // debounced effect still saves other settings (iface,
                // country, etc).
                settingsLocal.update({
                  exec_mode: m,
                  iface_a: iface,
                  iface_b: ifaceB,
                  iface_c: ifaceC,
                  country,
                  active_iface: activeIface,
                  chroot_path: chrootPath,
                }).catch((e) => console.warn("[settings] mode write failed:", e?.message));
              }}
              style={[
                s.segBtn,
                active && { backgroundColor: color, borderColor: color },
                disabled && { opacity: 0.4 },
              ]}
            >
              <MaterialCommunityIcons
                name={m === "mock" ? "shield-outline" : m === "real" ? "android" : "linux"}
                size={14}
                color={active ? C.bg : color}
              />
              <Text style={[s.segBtnText, { color: active ? C.bg : color }]}>
                {label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={s.helper}>
        {execMode === "kali"
          ? "commands wrapped via NetHunter chroot — runs inside Kali Linux"
          : execMode === "real"
          ? "commands hit `su -c` directly on the Android host"
          : "preview mode — no real exec, used when native bridge is unavailable"}
      </Text>
      {!HAS_NATIVE_ROOT && (
        <Text style={[s.helper, { marginTop: 4 }]}>
          REAL/KALI are only available in the built APK.
        </Text>
      )}

      {execMode === "kali" && (
        <View style={[s.field, { marginTop: 10 }]}>
          <Text style={s.fieldLabel}>chroot helper</Text>
          <TextInput
            testID="input-chroot-path"
            value={chrootPath}
            onChangeText={setChrootPath}
            style={s.fieldInput}
            placeholder="bootkali"
            placeholderTextColor={C.textDim}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={s.helper}>
            wrap: <Text style={{ color: C.magenta }}>{chrootPath.length > 60 ? chrootPath.slice(0, 57) + "…" : chrootPath}</Text>{" "}<Text style={{ color: C.green }}>&lt;cmd&gt;</Text>
          </Text>
        </View>
      )}

      {sshCfg ? (
        <SshBackendPanel
          config={sshCfg}
          status={sshStatus}
          statusDetail={sshStatusDetail}
          savedPw={sshSavedPw}
          savedKey={sshSavedKey}
          onApply={handleSshApply}
          onDisconnect={handleSshDisconnect}
        />
      ) : null}

      <View style={s.sectionRow}>
        <Text style={s.sectionTitle}>// pcap endpoints ({pcapEndpointsList.length})</Text>
        <TouchableOpacity testID="btn-pcap-new" onPress={() => openPcapEditor(null)} style={s.smallBtn}>
          <Ionicons name="add" size={14} color={C.magenta} />
          <Text style={[s.smallBtnText, { color: C.magenta }]}>add endpoint</Text>
        </TouchableOpacity>
      </View>
      <Text style={s.helper}>
        remote receivers for PCAP-over-IP streams. start a listener on the target:{"\n"}
        <Text style={{ color: C.cyan }}>nc -l -p 19000 | wireshark -k -i -</Text>{"\n"}
        then pick this endpoint when launching the &quot;PCAP → remote&quot; attack profile.
      </Text>
      {pcapEndpointsList.map((ep) => (
        <View key={ep.id} style={s.aiProfileBlock}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <MaterialCommunityIcons name="cloud-upload" size={22} color={C.magenta} style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <Text style={s.aiProfileName}>{ep.name}</Text>
              <Text style={[s.aiProfileCmd, { color: C.cyan }]}>
                {ep.transport}://{ep.host}:{ep.port}
              </Text>
              {!!ep.notes && <Text style={s.aiProfileDesc} numberOfLines={1}>{ep.notes}</Text>}
            </View>
            <View style={{ flexDirection: "row" }}>
              <TouchableOpacity testID={`btn-pcap-edit-${ep.id}`} onPress={() => openPcapEditor(ep)}
                style={[s.iconBtn, { borderWidth: 1, borderColor: C.cyan, marginRight: 6 }]}>
                <Ionicons name="create-outline" size={14} color={C.cyan} />
              </TouchableOpacity>
              <TouchableOpacity testID={`btn-pcap-del-${ep.id}`}
                onPress={() => deletePcapEndpoint(ep.id, ep.name)}
                style={[s.iconBtn, { borderWidth: 1, borderColor: C.red }]}>
                <Ionicons name="trash" size={14} color={C.red} />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ))}

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

      <Text style={[s.helper, { marginTop: 24, textAlign: "center" }]}>Enforcer Framework · v0.9</Text>
    </ScrollView>
  );

  // ─── Settings > AI Agents sub-tab ─────────────────────────────────────
  // Full CRUD for AIProfile docs. Each row shows the agent's icon, name,
  // command, and a 2-line meta strip with wrap_mode/view_mode/send_newline
  // badges. Tap a row to edit, swipe-style buttons to delete, top "+ new"
  // to create from scratch. Editor sheet is rendered at the bottom of the
  // App tree alongside other overlays.
  const renderAIProfiles = () => (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
      <View style={s.sectionRow}>
        <Text style={s.sectionTitle}>// agents ({aiProfilesList.length})</Text>
        <TouchableOpacity testID="btn-ai-new" onPress={() => openAIEditor(null)} style={s.smallBtn}>
          <Ionicons name="add" size={14} color={C.aiAccent} />
          <Text style={[s.smallBtnText, { color: C.aiAccent }]}>new agent</Text>
        </TouchableOpacity>
      </View>
      {aiProfilesList.map((p) => (
        <View key={p.id} style={s.aiProfileBlock}>
          <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
            <Text style={s.aiProfileIcon}>{p.icon || "🤖"}</Text>
            <View style={{ flex: 1 }}>
              <Text style={s.aiProfileName}>{p.name}</Text>
              <Text style={s.aiProfileCmd} numberOfLines={1}>
                {p.pre_command ? `${p.pre_command} && ` : ""}{p.command}
              </Text>
              {!!p.description && <Text style={s.aiProfileDesc} numberOfLines={2}>{p.description}</Text>}
              <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 4 }}>
                <View style={[s.aiBadge, { borderColor: C.aiAccent }]}>
                  <Text style={[s.aiBadgeText, { color: C.aiAccent }]}>view={p.view_mode || "xterm"}</Text>
                </View>
                <View style={[s.aiBadge, { borderColor: p.wrap_mode === "none" ? C.textDim : C.yellow }]}>
                  <Text style={[s.aiBadgeText, { color: p.wrap_mode === "none" ? C.textDim : C.yellow }]}>
                    wrap={p.wrap_mode || "none"}
                  </Text>
                </View>
                {p.send_newline === false && (
                  <View style={[s.aiBadge, { borderColor: C.magenta }]}>
                    <Text style={[s.aiBadgeText, { color: C.magenta }]}>no-newline</Text>
                  </View>
                )}
              </View>
            </View>
            <View style={{ flexDirection: "row" }}>
              <TouchableOpacity testID={`btn-ai-edit-${p.id}`} onPress={() => openAIEditor(p)}
                style={[s.iconBtn, { borderWidth: 1, borderColor: C.aiAccent, marginRight: 6 }]}>
                <Ionicons name="create-outline" size={14} color={C.aiAccent} />
              </TouchableOpacity>
              <TouchableOpacity testID={`btn-ai-del-${p.id}`}
                onPress={() => deleteAIProfile(p.id, p.name)}
                style={[s.iconBtn, { borderWidth: 1, borderColor: C.red }]}>
                <Ionicons name="trash" size={14} color={C.red} />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ))}
      {aiProfilesList.length === 0 && (
        <Text style={{ color: C.textDim, fontFamily: MONO, padding: 16, textAlign: "center" }}>
          no agents yet — tap &quot;new agent&quot; to add one
        </Text>
      )}
      <Text style={[s.helper, { marginTop: 16, textAlign: "center" }]}>
        agents are launched from the AI tab.{"\n"}
        edit here, run there.
      </Text>
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
            <Text style={[s.headerTitle, { marginLeft: 8 }]}>Enforcer Framework</Text>
            <Text style={s.headerVer}>v0.9</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            {running && <ActivityIndicator size="small" color={C.green} style={{ marginRight: 8 }} />}
            {backendKind === "ssh" ? (
              <View style={[s.badge, { borderColor: C.cyan }]}>
                <Text style={[s.badgeText, { color: C.cyan }]}>
                  {sshStatus === "connected" ? "SSH" : "SSH…"}
                </Text>
              </View>
            ) : (
              <View style={[s.badge, { borderColor: execMode === "kali" ? C.magenta : execMode === "real" ? C.green : C.yellow }]}>
                <Text style={[s.badgeText, { color: execMode === "kali" ? C.magenta : execMode === "real" ? C.green : C.yellow }]}>
                  {execMode === "kali" ? "KALI" : execMode === "real" ? "ANDROID" : "PREVIEW"}
                </Text>
              </View>
            )}
          </View>
        </View>

        {/* CONTENT */}
        <View style={{ flex: 1 }}>
          {tab === "quick" && renderQuick()}
          {tab === "terminal" && renderTerminal()}
          {tab === "live" && (
            <LiveTab
              iface={iface}
              ifaceB={ifaceB}
              ifaceC={ifaceC}
              primaryIface={primaryIface}
              country={country}
              execMode={backendKind === "ssh" ? "kali" : execMode}
              wrap={wrapForMode}
              apiBase={API}
            />
          )}
          {tab === "ai" && (
            <AITab
              execMode={backendKind === "ssh" ? "kali" : execMode}
              wrap={wrapForMode}
              apiBase={API}
              sshMode={backendKind === "ssh"}
            />
          )}
          {tab === "mcp" && <MCPTab />}
          {tab === "swat" && <SwatTab />}
          {tab === "profiles" && (() => {
            // Backwards-compat: an older app launch may have persisted
            // tab="profiles" before we removed it as a top-level tab. Punt
            // them into Settings > Profiles instead of showing a blank pane.
            // Use a microtask so we don't update state during render.
            setTimeout(() => { setSettingsSubTab("profiles"); setTab("settings"); }, 0);
            return null;
          })()}
          {tab === "settings" && renderSettings()}
        </View>

        {/* TAB BAR — 6 slots: quick, term, live, ai, mcp, settings.
            Profiles + AI agents stay nested under Settings sub-tabs so we
            don't blow past the comfortable tap-target width on the S10+. */}
        <View style={s.tabbar}>
          <TabBtn t="quick" cur={tab} icon="wifi" label="WLAN" onPress={setTab} />
          {/* term tab badge intentionally removed — it used to show
              logs.length (classic terminal command count), which had
              nothing to do with the persistent shell session and was
              routinely confusing ("why does term say (1) when I closed
              the shell?"). A proper "shell alive" indicator will land as
              part of the Control Bubble work. */}
          <TabBtn t="terminal" cur={tab} icon="console" label="term" onPress={setTab} />
          <TabBtn t="live" cur={tab} icon="satellite-uplink" label="live" onPress={setTab} />
          <TabBtn t="ai" cur={tab} icon="robot-outline" label="ai" onPress={setTab} />
          <TabBtn t="mcp" cur={tab} icon="hub" label="mcp" onPress={setTab} />
          <TabBtn t="swat" cur={tab} icon="shield-account" label="swat" onPress={setTab} />
          <TabBtn t="settings" cur={tab} icon="cog" label="set" onPress={setTab} />
        </View>

        {/* SAVE PROFILE INLINE PANEL */}
        {saveOpen && (
          <View style={s.overlay}>
            <View style={s.sheet}>
              <View style={s.sheetHeader}>
                <Text style={s.sheetTitle}>{stagedCombo ? "// save wlan combo" : "// save profile"}</Text>
                <TouchableOpacity onPress={() => { setSaveOpen(false); setStagedCombo(null); }} testID="btn-close-save">
                  <Ionicons name="close" size={22} color={C.green} />
                </TouchableOpacity>
              </View>
              <Text style={s.helper}>
                {stagedCombo
                  ? `snapshot ${stagedCombo.length} staged wlan command${stagedCombo.length === 1 ? "" : "s"} (iface=`
                  : "snapshot all 12 quick-action commands using active iface="}
                <Text style={{ color: C.cyan }}>{primaryIface}</Text>
                {stagedCombo ? ")" : <> $CC=<Text style={{ color: C.cyan }}>{country}</Text></>}
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
        {/* AI PROFILE EDITOR SHEET — full-screen overlay for adding/editing
            an agent. Mirrors the save-profile sheet pattern. */}
        {aiEditOpen && aiEditing && (
          <View style={s.overlay}>
            <View style={s.sheet}>
              <View style={s.sheetHeader}>
                <Text style={s.sheetTitle}>
                  {aiEditing.id ? `// edit ${aiEditing.name || "agent"}` : "// new agent"}
                </Text>
                <TouchableOpacity onPress={closeAIEditor} testID="btn-close-ai-edit">
                  <Ionicons name="close" size={22} color={C.green} />
                </TouchableOpacity>
              </View>
              <ScrollView
                style={{ maxHeight: 480 }}
                contentContainerStyle={{ paddingBottom: 8 }}
                keyboardShouldPersistTaps="handled"
              >
                <View style={s.field}>
                  <Text style={s.fieldLabel}>name *</Text>
                  <TextInput
                    testID="input-ai-name"
                    value={aiEditing.name}
                    onChangeText={(t) => setAiEditing({ ...aiEditing, name: t })}
                    style={s.fieldInput}
                    placeholder="Hermes"
                    placeholderTextColor={C.textDim}
                    autoCapitalize="words"
                    autoCorrect={false}
                  />
                </View>
                <View style={[s.field, { marginTop: 8 }]}>
                  <Text style={s.fieldLabel}>icon (emoji)</Text>
                  <TextInput
                    testID="input-ai-icon"
                    value={aiEditing.icon || ""}
                    onChangeText={(t) => setAiEditing({ ...aiEditing, icon: t })}
                    style={s.fieldInput}
                    placeholder="🤖"
                    placeholderTextColor={C.textDim}
                    maxLength={4}
                  />
                </View>
                <View style={[s.field, { marginTop: 8 }]}>
                  <Text style={s.fieldLabel}>launcher command *</Text>
                  <TextInput
                    testID="input-ai-command"
                    value={aiEditing.command}
                    onChangeText={(t) => setAiEditing({ ...aiEditing, command: t })}
                    style={s.fieldInput}
                    placeholder="hermes --cli"
                    placeholderTextColor={C.textDim}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
                <View style={[s.field, { marginTop: 8 }]}>
                  <Text style={s.fieldLabel}>description</Text>
                  <TextInput
                    testID="input-ai-desc"
                    value={aiEditing.description || ""}
                    onChangeText={(t) => setAiEditing({ ...aiEditing, description: t })}
                    style={[s.fieldInput, { minHeight: 56, textAlignVertical: "top", paddingTop: 8 }]}
                    placeholder="optional"
                    placeholderTextColor={C.textDim}
                    multiline
                    numberOfLines={2}
                    scrollEnabled
                  />
                </View>
                <View style={[s.field, { marginTop: 8 }]}>
                  <Text style={s.fieldLabel}>pre-command (run before launcher, joined with &amp;&amp;)</Text>
                  <TextInput
                    testID="input-ai-precmd"
                    value={aiEditing.pre_command || ""}
                    onChangeText={(t) => setAiEditing({ ...aiEditing, pre_command: t })}
                    style={[s.fieldInput, { minHeight: 70, textAlignVertical: "top", paddingTop: 8 }]}
                    placeholder="source ~/.hermes/.env && cd ~/.hermes"
                    placeholderTextColor={C.textDim}
                    autoCapitalize="none"
                    autoCorrect={false}
                    multiline
                    numberOfLines={3}
                    scrollEnabled
                  />
                </View>

                {/* wrap_mode segmented */}
                <Text style={[s.fieldLabel, { marginTop: 14 }]}>shell wrap</Text>
                <View style={[s.segGroup, { marginTop: 4 }]}>
                  {(["none", "pty", "unbuffered"] as const).map((m) => {
                    const active = (aiEditing.wrap_mode || "none") === m;
                    const color = m === "none" ? C.textDim : m === "pty" ? C.yellow : C.cyan;
                    return (
                      <TouchableOpacity
                        key={m}
                        testID={`btn-ai-wrap-${m}`}
                        onPress={() => setAiEditing({ ...aiEditing, wrap_mode: m })}
                        style={[s.segBtn, active && { backgroundColor: color, borderColor: color }]}
                      >
                        <Text style={[s.segBtnText, { color: active ? C.bg : color }]}>{m}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {/* view_mode segmented */}
                <Text style={[s.fieldLabel, { marginTop: 14 }]}>render mode</Text>
                <View style={[s.segGroup, { marginTop: 4 }]}>
                  {(["xterm", "scrollback"] as const).map((m) => {
                    const active = (aiEditing.view_mode || "xterm") === m;
                    const color = m === "xterm" ? C.aiAccent : C.textDim;
                    return (
                      <TouchableOpacity
                        key={m}
                        testID={`btn-ai-view-${m}`}
                        onPress={() => setAiEditing({ ...aiEditing, view_mode: m })}
                        style={[s.segBtn, active && { backgroundColor: color, borderColor: color }]}
                      >
                        <Text style={[s.segBtnText, { color: active ? C.bg : color }]}>
                          {m === "xterm" ? "TUI (xterm.js)" : "scrollback"}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {/* send_newline toggle */}
                <TouchableOpacity
                  testID="btn-ai-newline"
                  onPress={() => setAiEditing({ ...aiEditing, send_newline: aiEditing.send_newline === false })}
                  style={[s.row, { marginTop: 14, borderColor: (aiEditing.send_newline === false) ? C.magenta : C.greenDim }]}
                >
                  <MaterialCommunityIcons
                    name={(aiEditing.send_newline === false) ? "keyboard-off-outline" : "keyboard-return"}
                    size={16}
                    color={(aiEditing.send_newline === false) ? C.magenta : C.green}
                  />
                  <Text style={[s.rowText, { color: (aiEditing.send_newline === false) ? C.magenta : C.green }]}>
                    append newline on send: {(aiEditing.send_newline === false) ? "OFF" : "ON"}
                  </Text>
                </TouchableOpacity>
                <Text style={s.helper}>
                  most agents need newline = ON. turn OFF for raw-byte agents (rare).
                </Text>
              </ScrollView>

              <View style={{ flexDirection: "row", marginTop: 14, gap: 8 }}>
                <TouchableOpacity
                  onPress={closeAIEditor}
                  style={[s.bigBtn, { flex: 1, backgroundColor: "transparent", borderWidth: 1, borderColor: C.textDim }]}
                  disabled={aiSaving}
                >
                  <Text style={[s.bigBtnText, { color: C.textDim }]}>CANCEL</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  testID="btn-ai-save"
                  onPress={saveAIProfile}
                  style={[s.bigBtn, { flex: 2 }, aiSaving && { opacity: 0.5 }]}
                  disabled={aiSaving}
                >
                  {aiSaving
                    ? <ActivityIndicator size="small" color={C.bg} />
                    : <Ionicons name="save" size={16} color={C.bg} />}
                  <Text style={s.bigBtnText}>{aiEditing.id ? "SAVE CHANGES" : "CREATE"}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        {/* PCAP ENDPOINT EDITOR SHEET — simpler than AI editor: just name,
            host, port, transport, notes. Used from Settings → General. */}
        {pcapEditOpen && pcapEditing && (
          <View style={s.overlay}>
            <View style={s.sheet}>
              <View style={s.sheetHeader}>
                <Text style={s.sheetTitle}>
                  {pcapEditing.id ? `// edit ${pcapEditing.name || "endpoint"}` : "// new endpoint"}
                </Text>
                <TouchableOpacity onPress={closePcapEditor} testID="btn-close-pcap-edit">
                  <Ionicons name="close" size={22} color={C.green} />
                </TouchableOpacity>
              </View>
              <ScrollView style={{ maxHeight: 420 }} keyboardShouldPersistTaps="handled">
                <View style={s.field}>
                  <Text style={s.fieldLabel}>name *</Text>
                  <TextInput testID="input-pcap-name"
                    value={pcapEditing.name}
                    onChangeText={(t) => setPcapEditing({ ...pcapEditing, name: t })}
                    style={s.fieldInput}
                    placeholder="Wireshark LAN"
                    placeholderTextColor={C.textDim}
                  />
                </View>
                <View style={[s.field, { marginTop: 8 }]}>
                  <Text style={s.fieldLabel}>host * (IP or DNS)</Text>
                  <TextInput testID="input-pcap-host"
                    value={pcapEditing.host}
                    onChangeText={(t) => setPcapEditing({ ...pcapEditing, host: t })}
                    style={s.fieldInput}
                    placeholder="192.168.1.50 or pentest-rig.tail-net.ts"
                    placeholderTextColor={C.textDim}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                  />
                </View>
                <View style={[s.field, { marginTop: 8 }]}>
                  <Text style={s.fieldLabel}>port * (1..65535)</Text>
                  <TextInput testID="input-pcap-port"
                    value={String(pcapEditing.port ?? "")}
                    onChangeText={(t) => setPcapEditing({ ...pcapEditing, port: t.replace(/[^0-9]/g, "") })}
                    style={s.fieldInput}
                    placeholder="19000"
                    placeholderTextColor={C.textDim}
                    keyboardType="numeric"
                    maxLength={5}
                  />
                </View>

                <Text style={[s.fieldLabel, { marginTop: 14 }]}>transport</Text>
                <View style={[s.segGroup, { marginTop: 4 }]}>
                  {(["tcp", "udp"] as const).map((t) => {
                    const active = (pcapEditing.transport || "tcp") === t;
                    const color = t === "tcp" ? C.cyan : C.yellow;
                    return (
                      <TouchableOpacity
                        key={t}
                        testID={`btn-pcap-transport-${t}`}
                        onPress={() => setPcapEditing({ ...pcapEditing, transport: t })}
                        style={[s.segBtn, active && { backgroundColor: color, borderColor: color }]}
                      >
                        <Text style={[s.segBtnText, { color: active ? C.bg : color }]}>
                          {t.toUpperCase()}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <Text style={[s.helper, { marginTop: 4 }]}>
                  TCP for nc + Wireshark; UDP for occasional broker setups (uncommon).
                </Text>

                <View style={[s.field, { marginTop: 12 }]}>
                  <Text style={s.fieldLabel}>notes</Text>
                  <TextInput testID="input-pcap-notes"
                    value={pcapEditing.notes || ""}
                    onChangeText={(t) => setPcapEditing({ ...pcapEditing, notes: t })}
                    style={[s.fieldInput, { minHeight: 56, textAlignVertical: "top", paddingTop: 8 }]}
                    placeholder="optional — e.g. 'remember to start nc -l on port first'"
                    placeholderTextColor={C.textDim}
                    multiline
                    numberOfLines={2}
                  />
                </View>
              </ScrollView>

              <View style={{ flexDirection: "row", marginTop: 14, gap: 8 }}>
                <TouchableOpacity onPress={closePcapEditor}
                  style={[s.bigBtn, { flex: 1, backgroundColor: "transparent", borderWidth: 1, borderColor: C.textDim }]}
                  disabled={pcapSaving}>
                  <Text style={[s.bigBtnText, { color: C.textDim }]}>CANCEL</Text>
                </TouchableOpacity>
                <TouchableOpacity testID="btn-pcap-save" onPress={savePcapEndpoint}
                  style={[s.bigBtn, { flex: 2 }, pcapSaving && { opacity: 0.5 }]}
                  disabled={pcapSaving}>
                  {pcapSaving
                    ? <ActivityIndicator size="small" color={C.bg} />
                    : <Ionicons name="save" size={16} color={C.bg} />}
                  <Text style={s.bigBtnText}>{pcapEditing.id ? "SAVE CHANGES" : "CREATE"}</Text>
                </TouchableOpacity>
              </View>
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

  // ─── Settings sub-tab bar ──────────────────────────────────────────────
  // Sits right under the screen header at the top of the Settings tab.
  // Cosmetically a row of pill-shaped buttons; the active one gets a
  // green underline + brightened text so it reads similar to the bottom
  // tab bar's active-state idiom.
  subTabBar: {
    flexDirection: "row",
    backgroundColor: C.panel,
    borderBottomWidth: 1, borderBottomColor: C.border,
    paddingHorizontal: 8, paddingTop: 8, paddingBottom: 4,
    gap: 6,
  },
  subTab: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    paddingVertical: 8, paddingHorizontal: 8, gap: 6,
    borderRadius: 4, borderWidth: 1, borderColor: C.border, backgroundColor: C.panel2,
  },
  subTabActive: { borderColor: C.green, backgroundColor: "#0a2010" },
  subTabText: { fontFamily: MONO, fontSize: 11, color: C.textDim, letterSpacing: 0.5 },

  // ─── AI agent rows (Settings > Agents sub-tab) ─────────────────────────
  aiProfileBlock: {
    backgroundColor: C.panel, borderWidth: 1, borderColor: C.border,
    borderRadius: 4, padding: 12, marginBottom: 8,
  },
  aiProfileIcon: { fontSize: 22, marginRight: 10, marginTop: 2 },
  aiProfileName: { color: C.text, fontFamily: MONO, fontSize: 14, fontWeight: "700" },
  aiProfileCmd: { color: C.aiAccent, fontFamily: MONO, fontSize: 11, marginTop: 2 },
  aiProfileDesc: { color: C.textDim, fontFamily: MONO, fontSize: 11, marginTop: 4 },
  aiBadge: {
    paddingHorizontal: 6, paddingVertical: 2,
    borderWidth: 1, borderRadius: 3, marginRight: 4, marginTop: 2,
  },
  aiBadgeText: { fontFamily: MONO, fontSize: 9, letterSpacing: 0.5 },

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

  chipRow: { flexDirection: "row", marginTop: 4 },
  chip: {
    paddingHorizontal: 14, paddingVertical: 6,
    borderWidth: 1, borderColor: C.border, borderRadius: 3,
    backgroundColor: C.panel, marginRight: 6, minWidth: 44, alignItems: "center",
  },
  chipText: { color: C.green, fontFamily: MONO, fontSize: 12, fontWeight: "600" },

  segGroup: { flexDirection: "row", marginBottom: 6 },
  segBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: C.border, backgroundColor: C.panel,
    paddingVertical: 10, marginRight: 4, borderRadius: 4,
  },
  segBtnText: { fontFamily: MONO, fontSize: 11, fontWeight: "800", letterSpacing: 1, marginLeft: 4 },

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
