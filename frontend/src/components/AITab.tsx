import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  View, Text, StyleSheet, ScrollView, FlatList, TouchableOpacity, TextInput, Alert, Platform,
  KeyboardAvoidingView,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { sessionManager, SessionState } from "../lib/sessionManager";
import { hasNativeStreaming, HAS_NATIVE_ROOT } from "../lib/rootShell";

// ─── Palette: keep unified with LiveTab / Settings / Terminal ─────────────
const C = {
  bg: "#04070a", panel: "#0a1116", panel2: "#0e1820", border: "#163041",
  green: "#00ff66", greenDim: "#0a8a3a", cyan: "#3ad7ff", red: "#ff3860",
  yellow: "#ffd400", magenta: "#ff5cdb", text: "#cfeadb", textDim: "#6c8a82",
  // AI-specific accent — a slightly purple-shifted cyan so AI output reads
  // distinct from raw command output without clashing with the rest of the UI.
  aiAccent: "#b08aff",
  userPrompt: "#ffd400",  // user-input echo lines (▸ marker)
};
const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

// ─── Types ─────────────────────────────────────────────────────────────────
export type AIProfile = {
  id: string;
  name: string;
  command: string;
  description: string;
  wrap_mode: "none" | "pty" | "unbuffered";
  send_newline: boolean;
  send_initial: string | null;
  pre_command: string | null;
  icon: string;
  created_at: string;
};

type Props = {
  execMode: "mock" | "real" | "kali";
  wrap: (cmd: string) => string;   // outer exec-mode wrapper (kali chroot etc.)
  apiBase: string;                  // backend URL for ai-profiles + ai-logs
};

// ─── Helpers ───────────────────────────────────────────────────────────────
/**
 * Decide what to actually `exec` for an AI session. We always spawn a login
 * shell (`bash -l`) — that way the rc-file sourcing chain (/etc/profile →
 * /etc/bash.bashrc → ~/.bashrc → optionally ~/.profile) fires synchronously
 * before the shell reads stdin. The actual launcher command (hermes, cai,
 * …) is then written into the shell's stdin via sessionManager.sendInput
 * once the session is running.
 *
 * Rationale: previously we did `sudo -E hermes` directly, which spawned
 * hermes in a bare environment (no .zshrc, no .bashrc, no venv activation,
 * no $HOME assumptions). Hermes thought it was on a brand-new install
 * because none of its state files were findable. Going through `bash -l`
 * reproduces exactly the env a real NetHunter terminal would have.
 *
 * `wrap_mode` controls optional pty/unbuffer wrapping around the login
 * shell — same as before, just one level out.
 */
function applyAIWrap(mode: AIProfile["wrap_mode"]): string {
  const loginShell = "bash -l";
  if (mode === "pty") {
    // pty wrapping for agents that need a real TTY (readline, ncurses, …)
    return `script -qc '${loginShell}' /dev/null`;
  }
  if (mode === "unbuffered") {
    return `unbuffer ${loginShell}`;
  }
  return loginShell;
}

// ─── Module-level state that survives tab unmounts ───────────────────────
// AITab is unmounted/remounted by index.tsx every time the user switches
// tabs. To make sessions feel persistent across tab switches we stash the
// active session id + the user's profile selection at module scope. The
// underlying SessionState already lives in sessionManager (singleton), so
// we just need to remember which id to look up.
const aiTabPersistent: {
  activeSessionId: string | null;
  selectedId: string | null;
} = {
  activeSessionId: null,
  selectedId: null,
};

// ──────────────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────────────
export default function AITab(props: Props) {
  const [profiles, setProfiles] = useState<AIProfile[]>([]);
  const [selectedId, setSelectedIdState] = useState<string | null>(aiTabPersistent.selectedId);
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(aiTabPersistent.activeSessionId);
  const [activeSession, setActiveSession] = useState<SessionState | null>(
    aiTabPersistent.activeSessionId ? sessionManager.sessions.get(aiTabPersistent.activeSessionId) || null : null,
  );
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<FlatList | null>(null);
  const autoScrollRef = useRef<boolean>(true);

  // Persisted setters — write to module-level on every change so the next
  // mount can pick up where we left off.
  const setSelectedId = useCallback((id: string | null) => {
    aiTabPersistent.selectedId = id;
    setSelectedIdState(id);
  }, []);
  const setActiveSessionId = useCallback((id: string | null) => {
    aiTabPersistent.activeSessionId = id;
    setActiveSessionIdState(id);
  }, []);

  // Configure sessionManager with the API base (idempotent, sessionManager guards re-init)
  useEffect(() => { sessionManager.configure(props.apiBase); }, [props.apiBase]);

  // On mount: if we had an active session, refresh the activeSession mirror
  // (the session may have produced more output while this tab was unmounted)
  useEffect(() => {
    if (activeSessionId) {
      const s = sessionManager.sessions.get(activeSessionId);
      setActiveSession(s || null);
      // If the session is gone entirely (e.g. ended + cleaned up), forget it
      if (!s) {
        aiTabPersistent.activeSessionId = null;
        setActiveSessionIdState(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to sessionManager updates
  useEffect(() => {
    const unsub = sessionManager.subscribe(() => {
      if (activeSessionId) {
        const s = sessionManager.sessions.get(activeSessionId) || null;
        setActiveSession(s);
      }
    });
    return unsub;
  }, [activeSessionId]);

  // Load AI profiles
  const fetchProfiles = useCallback(async () => {
    try {
      const r = await fetch(`${props.apiBase}/ai-profiles`);
      if (!r.ok) return;
      const data = await r.json();
      setProfiles(data);
      if (!selectedId && data.length) setSelectedId(data[0].id);
    } catch {
      // network failure is non-fatal in this tab
    }
  }, [props.apiBase, selectedId]);

  useEffect(() => { fetchProfiles(); }, [fetchProfiles]);

  // Auto-scroll to bottom when new output arrives (unless user scrolled up)
  useEffect(() => {
    if (autoScrollRef.current && activeSession && scrollRef.current) {
      // Use requestAnimationFrame to ensure layout is settled
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
    }
  }, [activeSession?.lineCount]);

  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === selectedId) || null,
    [profiles, selectedId],
  );

  const isRunning = activeSession && (activeSession.status === "running" || activeSession.status === "starting");
  const canStart = !!selectedProfile && !isRunning;
  const canStop = !!activeSession && isRunning;
  const canSend = !!isRunning && !sending;

  // ─── Start / Stop ────────────────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    if (!selectedProfile) return;
    if (!HAS_NATIVE_ROOT || !hasNativeStreaming()) {
      Alert.alert(
        "Native build required",
        "AI agents need the native root bridge + streaming. Build a real APK (`eas build`) and run on your device — this won't work in Expo Go or web preview.",
      );
      return;
    }
    // Step 1: launch a login shell (bash -l) wrapped by the chosen pty/unbuffer
    // mode and the outer exec-mode chroot prefix. This shell will source rc
    // files (/etc/profile, /etc/bash.bashrc, ~/.bashrc) before reading stdin,
    // so the hermes/cai/etc launcher gets a fully-bootstrapped environment.
    const shellInvocation = applyAIWrap(selectedProfile.wrap_mode);
    const wrappedShell = props.wrap(shellInvocation);
    try {
      const id = await sessionManager.start({
        command: wrappedShell,
        label: selectedProfile.name,
      });
      setActiveSessionId(id);
      setActiveSession(sessionManager.sessions.get(id) || null);
      // Log session start
      fetch(`${props.apiBase}/ai-logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile_id: selectedProfile.id,
          profile_name: selectedProfile.name,
          session_id: id,
          kind: "system",
          content: `session started · shell=${shellInvocation} · launcher=${selectedProfile.command}`,
        }),
      }).catch(() => {});

      // Step 2: send the launcher command (and optional pre_command) into the
      // login shell's stdin. Wait ~800ms so bash has time to source its rc
      // files before our line lands in its input queue (otherwise our line
      // might race ahead of rc execution and run in a half-bootstrapped env).
      const launcher = selectedProfile.pre_command
        ? `${selectedProfile.pre_command} && ${selectedProfile.command}`
        : selectedProfile.command;
      setTimeout(() => {
        sessionManager.sendInput(id, launcher, true).catch(() => {});
      }, 800);

      // Step 3: optional send_initial — auto-sent ~1.5s after the launcher
      // boots so the agent has time to print its banner before we feed it.
      if (selectedProfile.send_initial) {
        setTimeout(() => {
          sessionManager.sendInput(id, selectedProfile.send_initial!, selectedProfile.send_newline).catch(() => {});
        }, 2300);
      }
    } catch (e: any) {
      Alert.alert("Failed to start", e?.message || "Unknown error");
    }
  }, [selectedProfile, props.wrap, props.apiBase]);

  const handleStop = useCallback(async () => {
    if (!activeSessionId) return;
    Alert.alert(
      "Stop agent?",
      `Send SIGTERM to ${selectedProfile?.name ?? "agent"}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "SIGTERM",
          onPress: () => sessionManager.kill(activeSessionId, true).catch(() => {}),
        },
        {
          text: "SIGKILL",
          style: "destructive",
          onPress: () => sessionManager.kill(activeSessionId, false).catch(() => {}),
        },
      ],
    );
  }, [activeSessionId, selectedProfile]);

  // ─── Send input ──────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    if (!activeSessionId || !inputText.trim()) return;
    const profile = selectedProfile;
    setSending(true);
    const textToSend = inputText;
    setInputText("");
    try {
      await sessionManager.sendInput(
        activeSessionId,
        textToSend,
        profile?.send_newline ?? true,
      );
      // Log user input (fire-and-forget)
      fetch(`${props.apiBase}/ai-logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile_id: profile?.id,
          profile_name: profile?.name ?? "",
          session_id: activeSessionId,
          kind: "user",
          content: textToSend,
        }),
      }).catch(() => {});
    } finally {
      setSending(false);
    }
  }, [activeSessionId, inputText, selectedProfile, props.apiBase]);

  // ─── Clear current session output (local only) ───────────────────────────
  const handleClear = useCallback(() => {
    if (!activeSessionId) return;
    Alert.alert(
      "Clear transcript?",
      "Wipe the visible scrollback for this session. The agent keeps running.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: () => {
            const s = sessionManager.sessions.get(activeSessionId);
            if (s) {
              s.lines = [];
              setActiveSession({ ...s });
            }
          },
        },
      ],
    );
  }, [activeSessionId]);

  // ─── Render ──────────────────────────────────────────────────────────────
  const lines = activeSession?.lines || [];

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={s.root}
      keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}
    >
      {/* Profile selector */}
      <View style={s.profileBar}>
        <Text style={s.sectionLabel}>{"// agent"}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingRight: 12 }}>
          {profiles.map((p) => {
            const active = p.id === selectedId;
            return (
              <TouchableOpacity
                key={p.id}
                disabled={!!isRunning}
                onPress={() => setSelectedId(p.id)}
                style={[s.chip, active && s.chipActive, isRunning && { opacity: 0.5 }]}
                activeOpacity={0.7}
              >
                <Text style={[s.chipIcon, active && { color: C.aiAccent }]}>{p.icon}</Text>
                <Text style={[s.chipLabel, active && { color: C.aiAccent }]}>{p.name}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* Description / status row */}
      {selectedProfile && (
        <View style={s.descRow}>
          <Text style={s.descText} numberOfLines={2}>
            <Text style={{ color: C.aiAccent }}>{selectedProfile.command}</Text>
            {selectedProfile.wrap_mode !== "none" && (
              <Text style={{ color: C.yellow }}>  · wrap={selectedProfile.wrap_mode}</Text>
            )}
            {selectedProfile.description ? (
              <Text style={{ color: C.textDim }}>  · {selectedProfile.description}</Text>
            ) : null}
          </Text>
        </View>
      )}

      {/* Control bar */}
      <View style={s.controlBar}>
        <TouchableOpacity
          onPress={canStart ? handleStart : canStop ? handleStop : undefined}
          disabled={!canStart && !canStop}
          style={[s.bigBtn, canStop ? s.bigBtnStop : s.bigBtnStart, (!canStart && !canStop) && { opacity: 0.4 }]}
          activeOpacity={0.8}
        >
          <MaterialCommunityIcons
            name={canStop ? "stop-circle" : "play-circle"}
            size={22}
            color={canStop ? C.red : C.green}
          />
          <Text style={[s.bigBtnText, { color: canStop ? C.red : C.green }]}>
            {canStop ? "STOP" : isRunning ? "starting…" : "START"}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={handleClear} disabled={!activeSession} style={[s.miniBtn, !activeSession && { opacity: 0.4 }]}>
          <MaterialCommunityIcons name="broom" size={16} color={C.textDim} />
          <Text style={s.miniBtnText}>clear</Text>
        </TouchableOpacity>

        {activeSession && (
          <View style={s.statusPill}>
            <Text style={[s.statusText, {
              color: activeSession.status === "running" ? C.green
                : activeSession.status === "starting" ? C.yellow
                : activeSession.status === "ended" ? C.textDim
                : C.red,
            }]}>
              {activeSession.status}
              {activeSession.pid ? ` · pid ${activeSession.pid}` : ""}
              {activeSession.lineCount ? ` · ${activeSession.lineCount} lines` : ""}
            </Text>
          </View>
        )}
      </View>

      {/* Transcript pane */}
      {lines.length === 0 ? (
        <ScrollView
          style={s.transcript}
          contentContainerStyle={{ padding: 8 }}
        >
          <Text style={s.placeholder}>
            {isRunning
              ? "// waiting for agent output…"
              : selectedProfile
              ? `// tap START to launch ${selectedProfile.name}`
              : "// no agent selected"}
          </Text>
        </ScrollView>
      ) : (
        <FlatList
          ref={scrollRef}
          style={s.transcript}
          contentContainerStyle={{ padding: 8 }}
          data={lines}
          keyExtractor={(l, i) => `${l.line_no}-${i}`}
          renderItem={({ item: l }) => {
            const isUserEcho = l.line.startsWith("▸ ");
            const isStderr = l.stream === "stderr";
            return (
              <Text
                style={[
                  s.line,
                  isUserEcho && { color: C.userPrompt },
                  isStderr && !isUserEcho && { color: C.red },
                ]}
                selectable
              >
                {l.line}
              </Text>
            );
          }}
          onScrollBeginDrag={() => { autoScrollRef.current = false; }}
          onMomentumScrollEnd={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            const distance = contentSize.height - (contentOffset.y + layoutMeasurement.height);
            if (distance < 40) autoScrollRef.current = true;
          }}
          // Same virtualization tuning as LiveTab — keep dmesg-style bursts
          // from rendering thousands of <Text> simultaneously on the UI
          // thread (the original ANR cause per 06-06 crash log).
          initialNumToRender={30}
          maxToRenderPerBatch={20}
          windowSize={10}
          removeClippedSubviews={Platform.OS === "android"}
        />
      )}

      {/* Input bar */}
      <View style={s.inputBar}>
        <TextInput
          style={s.input}
          value={inputText}
          onChangeText={setInputText}
          placeholder={isRunning ? "message agent…" : "(start a session first)"}
          placeholderTextColor={C.textDim}
          editable={!!isRunning}
          multiline
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
        />
        <TouchableOpacity
          onPress={handleSend}
          disabled={!canSend || !inputText.trim()}
          style={[s.sendBtn, (!canSend || !inputText.trim()) && { opacity: 0.4 }]}
          activeOpacity={0.7}
        >
          <MaterialCommunityIcons name="send" size={18} color={C.aiAccent} />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  profileBar: {
    paddingTop: 8, paddingHorizontal: 10, paddingBottom: 6,
    borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.panel,
  },
  sectionLabel: { fontFamily: MONO, color: C.textDim, fontSize: 10, marginBottom: 4 },
  chip: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 10, paddingVertical: 6, marginRight: 6,
    borderWidth: 1, borderColor: C.border, borderRadius: 4, backgroundColor: C.panel2,
  },
  chipActive: { borderColor: C.aiAccent, backgroundColor: "#1a1428" },
  chipIcon: { fontSize: 14, marginRight: 6 },
  chipLabel: { fontFamily: MONO, fontSize: 12, color: C.text },
  descRow: {
    paddingHorizontal: 12, paddingVertical: 6,
    backgroundColor: C.panel, borderBottomWidth: 1, borderBottomColor: C.border,
  },
  descText: { fontFamily: MONO, fontSize: 11 },
  controlBar: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 8,
    backgroundColor: C.panel, borderBottomWidth: 1, borderBottomColor: C.border, gap: 8,
  },
  bigBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 4, borderWidth: 1,
  },
  bigBtnStart: { backgroundColor: "#0a2010", borderColor: C.greenDim },
  bigBtnStop: { backgroundColor: "#2a0a10", borderColor: C.red },
  bigBtnText: { fontFamily: MONO, fontSize: 13, fontWeight: "700" },
  miniBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: 4, borderWidth: 1, borderColor: C.border, backgroundColor: C.panel2,
  },
  miniBtnText: { fontFamily: MONO, fontSize: 11, color: C.textDim },
  statusPill: { marginLeft: "auto", paddingHorizontal: 8, paddingVertical: 4 },
  statusText: { fontFamily: MONO, fontSize: 10 },
  transcript: { flex: 1, backgroundColor: C.bg },
  placeholder: { fontFamily: MONO, color: C.textDim, fontSize: 12, padding: 8, fontStyle: "italic" },
  line: { fontFamily: MONO, color: C.text, fontSize: 11, lineHeight: 16 },
  inputBar: {
    flexDirection: "row", alignItems: "flex-end", gap: 6,
    paddingHorizontal: 8, paddingVertical: 6, paddingBottom: Platform.OS === "ios" ? 6 : 8,
    backgroundColor: C.panel, borderTopWidth: 1, borderTopColor: C.border,
  },
  input: {
    flex: 1, fontFamily: MONO, fontSize: 13, color: C.text,
    backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: 4,
    paddingHorizontal: 10, paddingVertical: Platform.OS === "ios" ? 10 : 6,
    minHeight: 40, maxHeight: 120,
  },
  sendBtn: {
    width: 44, height: 44, alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: C.aiAccent, borderRadius: 4, backgroundColor: "#1a1428",
  },
});
