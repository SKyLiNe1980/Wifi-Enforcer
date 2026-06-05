import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Alert, Platform,
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
  icon: string;
  created_at: string;
};

type Props = {
  execMode: "mock" | "real" | "kali";
  wrap: (cmd: string) => string;   // outer exec-mode wrapper (kali chroot etc.)
  apiBase: string;                  // backend URL for ai-profiles + ai-logs
};

// ─── Helpers ───────────────────────────────────────────────────────────────
/** Apply pty/unbuffer wrapping to the raw command BEFORE the exec-mode wrap. */
function applyAIWrap(rawCmd: string, mode: AIProfile["wrap_mode"]): string {
  if (mode === "pty") {
    // `script -qc "..." /dev/null` allocates a pty without writing a typescript.
    // Escape any double quotes in the command body so we don't break out.
    const escaped = rawCmd.replace(/"/g, '\\"');
    return `script -qc "${escaped}" /dev/null`;
  }
  if (mode === "unbuffered") {
    return `unbuffer ${rawCmd}`;
  }
  return rawCmd;
}

// ──────────────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────────────
export default function AITab(props: Props) {
  const [profiles, setProfiles] = useState<AIProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<SessionState | null>(null);
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<ScrollView | null>(null);
  const autoScrollRef = useRef<boolean>(true);

  // Configure sessionManager with the API base (idempotent, sessionManager guards re-init)
  useEffect(() => { sessionManager.configure(props.apiBase); }, [props.apiBase]);

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
    const raw = applyAIWrap(selectedProfile.command, selectedProfile.wrap_mode);
    const wrapped = props.wrap(raw);
    try {
      const id = await sessionManager.start({
        command: wrapped,
        label: selectedProfile.name,
      });
      setActiveSessionId(id);
      setActiveSession(sessionManager.sessions.get(id) || null);
      // Log session start to ai-logs (fire-and-forget)
      fetch(`${props.apiBase}/ai-logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile_id: selectedProfile.id,
          profile_name: selectedProfile.name,
          session_id: id,
          kind: "system",
          content: `session started · command=${selectedProfile.command} · wrap=${selectedProfile.wrap_mode}`,
        }),
      }).catch(() => {});
      // If profile has a send_initial, auto-send it after a small delay so the
      // agent has time to print its banner / settle stdin before we feed it.
      if (selectedProfile.send_initial) {
        setTimeout(() => {
          sessionManager.sendInput(id, selectedProfile.send_initial!, selectedProfile.send_newline).catch(() => {});
        }, 1500);
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
        <Text style={s.sectionLabel}>// agent</Text>
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
      <ScrollView
        ref={scrollRef}
        style={s.transcript}
        contentContainerStyle={{ padding: 8 }}
        onScrollBeginDrag={() => { autoScrollRef.current = false; }}
        onMomentumScrollEnd={(e) => {
          // Re-enable auto-scroll if user dragged to within 40px of the bottom
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          const distance = contentSize.height - (contentOffset.y + layoutMeasurement.height);
          if (distance < 40) autoScrollRef.current = true;
        }}
      >
        {lines.length === 0 ? (
          <Text style={s.placeholder}>
            {isRunning
              ? "// waiting for agent output…"
              : selectedProfile
              ? `// tap START to launch ${selectedProfile.name}`
              : "// no agent selected"}
          </Text>
        ) : (
          lines.map((l, i) => {
            const isUserEcho = l.line.startsWith("▸ ");
            const isStderr = l.stream === "stderr";
            return (
              <Text
                key={`${l.line_no}-${i}`}
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
          })
        )}
      </ScrollView>

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
