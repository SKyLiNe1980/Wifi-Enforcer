/**
 * TerminalShell — persistent interactive shell view for the Terminal tab.
 *
 * Unlike the classic Terminal view (one-shot `su -c '<cmd>'` per RUN tap,
 * no state between commands), this spawns a real login shell once and
 * keeps it alive for the whole session — so `cd /root` actually sticks,
 * env vars persist, command history works, vim/nano/htop run, etc.
 *
 * Architecture mirrors AITab:
 *   • A SessionManager session running `zsh -l` (fallback bash) wrapped in
 *     util-linux `script` (PTY) so the shell believes it has a real
 *     terminal (otherwise it'd disable colors, prompt redraw, and
 *     readline editing).
 *   • XTermView renders the byte stream + forwards keystrokes back to
 *     stdin via writeStdin.
 *   • Session id is stashed in module-level state so tab switches don't
 *     kill the shell — the user can pop into Quick, back to Terminal,
 *     and find their shell still alive with command history intact.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { sessionManager, SessionState } from "../lib/sessionManager";
import { hasNativeStreaming, HAS_NATIVE_ROOT, writeStdin } from "../lib/rootShell";
import XTermView from "./XTermView";

const C = {
  bg: "#04070a", panel: "#0a1116", panel2: "#0e1820", border: "#163041",
  green: "#00ff66", greenDim: "#0a8a3a", cyan: "#3ad7ff",
  red: "#ff3860", yellow: "#ffd400", magenta: "#ff5cdb",
  text: "#cfeadb", textDim: "#6c8a82",
};
const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

type Props = {
  execMode: "mock" | "real" | "kali";
  wrap: (cmd: string) => string;
  /** Optional: a one-shot command to inject as if the user typed it.
   *  Quick action buttons use this to fire commands into the shell. */
  pendingInjection?: { id: number; cmd: string };
};

// Module-level persistence — survives tab unmounts so the shell stays
// alive when the user pops out to Quick / Live / Settings and back.
const persistent: { sessionId: string | null } = { sessionId: null };

/**
 * Pick the shell invocation. PTY-wrap is non-optional here: an interactive
 * login shell without a TTY will:
 *   - disable colors (no `\e[…m` emitted)
 *   - skip rc-file zsh prompt setup
 *   - drop readline editing (no line history, no Ctrl-R)
 * `script` from util-linux is the most portable PTY allocator inside the
 * Kali chroot. We explicitly set SHELL=/bin/zsh because `script` reads
 * $SHELL to decide what to spawn, and inside the chroot it would
 * otherwise inherit Android's /system/bin/sh from the host context.
 *
 * Falls back to `bash -l` if zsh is missing (`|| bash -l` chained inside
 * the same `script` invocation so the PTY is still set up correctly).
 */
function shellInvocation(): string {
  // Same TUI-friendly env block as AITab's applyAIWrap — see AITab.tsx for
  // the per-var rationale. We keep these in sync deliberately so an
  // interactive shell and an AI agent see identical terminal capability.
  return `SHELL=/bin/zsh HOME=/root TERM=xterm-256color COLORTERM=truecolor FORCE_COLOR=1 COLUMNS=120 LINES=40 PYTHONUNBUFFERED=1 script -qc 'zsh -l 2>/dev/null || bash -l' /dev/null`;
}

export default function TerminalShell({ execMode, wrap, pendingInjection }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(persistent.sessionId);
  const [, force] = useState(0);
  const lastInjectionRef = useRef<number | null>(null);

  // Re-render on every session manager notify so the status pill / output
  // stays current. XTermView has its own subscription too, but we need
  // the pill in our header to update without remounting the xterm.
  useEffect(() => {
    const unsub = sessionManager.subscribe(() => force((n) => n + 1));
    return unsub;
  }, []);

  // Resolve the live session (or null if it died while we were away).
  const session: SessionState | null = sessionId
    ? sessionManager.sessions.get(sessionId) || null
    : null;
  const running = !!session && (session.status === "running" || session.status === "starting");

  // ─── Start / stop ─────────────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    if (!HAS_NATIVE_ROOT || !hasNativeStreaming()) {
      Alert.alert(
        "Native build required",
        "Persistent shell needs the native streaming bridge. Build the APK (`eas build -p android --profile preview`) and run on your device.",
      );
      return;
    }
    if (execMode === "mock") {
      Alert.alert(
        "Preview mode",
        "Switch to ANDROID or KALI in Settings → execution mode to spawn a real persistent shell.",
      );
      return;
    }
    try {
      const id = await sessionManager.start({
        command: wrap(shellInvocation()),
        label: "shell",
      });
      persistent.sessionId = id;
      setSessionId(id);
      force((n) => n + 1);
    } catch (e: any) {
      Alert.alert("Failed to start shell", e?.message || "Unknown error");
    }
  }, [execMode, wrap]);

  const handleStop = useCallback(() => {
    if (!sessionId) return;
    Alert.alert(
      "Close shell?",
      "Send EOF and kill the session?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "EOF (graceful)",
          onPress: async () => {
            // Try a graceful exit first: write the shell's "logout" sequence.
            await writeStdin(sessionId, "exit", true).catch(() => {});
            setTimeout(() => sessionManager.kill(sessionId, true).catch(() => {}), 400);
          },
        },
        {
          text: "SIGKILL",
          style: "destructive",
          onPress: () => sessionManager.kill(sessionId, false).catch(() => {}),
        },
      ],
    );
  }, [sessionId]);

  const handleClear = useCallback(() => {
    if (!sessionId) return;
    // Send Ctrl-L (form-feed, the canonical "clear screen" keystroke).
    // xterm.js will interpret it as a real clear, no need to also wipe
    // the session ring buffer.
    writeStdin(sessionId, "\x0c", false).catch(() => {});
  }, [sessionId]);

  // ─── Copy session scrollback to clipboard ────────────────────────────
  // xterm.js + RN WebView don't easily expose long-press text-select on
  // Android. This button grabs the session's line ring buffer (which
  // mirrors what xterm just rendered) and dumps it to the system
  // clipboard. Lossy w.r.t. ANSI escapes (sessionManager stored stripped
  // lines), but for "I need to paste this curl output into a chat" the
  // plain text is what you want anyway.
  const handleCopy = useCallback(async () => {
    if (!sessionId) return;
    const s = sessionManager.sessions.get(sessionId);
    if (!s || s.lines.length === 0) {
      Alert.alert("Nothing to copy", "Session buffer is empty.");
      return;
    }
    const text = s.lines.map((l) => l.line).join("\n");
    try {
      await Clipboard.setStringAsync(text);
      Alert.alert("Copied", `${s.lines.length} lines (${text.length} chars) on clipboard.`);
    } catch (e: any) {
      Alert.alert("Copy failed", e?.message || "Unknown error");
    }
  }, [sessionId]);

  // ─── Input from xterm WebView ────────────────────────────────────────
  const handleXTermInput = useCallback(
    (data: string) => {
      if (!sessionId) return;
      writeStdin(sessionId, data, false).catch(() => {});
    },
    [sessionId],
  );

  // ─── Quick-command injection from parent ─────────────────────────────
  // The parent's quick action buttons can push a one-shot command into
  // the shell via the `pendingInjection` prop. We dedupe by .id so the
  // same command doesn't fire twice on re-render.
  useEffect(() => {
    if (!pendingInjection || !sessionId) return;
    if (lastInjectionRef.current === pendingInjection.id) return;
    lastInjectionRef.current = pendingInjection.id;
    writeStdin(sessionId, pendingInjection.cmd, true).catch(() => {});
  }, [pendingInjection, sessionId]);

  // ─── Auto-clean expired session id from persistent state ─────────────
  // If the user kills the shell and we keep its id in module-level state,
  // a tab re-mount would find the missing session and render an empty
  // terminal. Reset to null whenever the session terminates.
  useEffect(() => {
    if (sessionId && !session) {
      persistent.sessionId = null;
      setSessionId(null);
    } else if (session && (session.status === "ended" || session.status === "killed" || session.status === "error")) {
      // session ended naturally — keep the id around briefly so the user
      // can see the final scrollback, then null it on the next start.
    }
  }, [sessionId, session]);

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <View style={s.root}>
      {/* Control bar — mirrors AI tab's start/stop pattern */}
      <View style={s.controlBar}>
        <TouchableOpacity
          onPress={running ? handleStop : handleStart}
          style={[s.bigBtn, running ? s.bigBtnStop : s.bigBtnStart]}
          activeOpacity={0.8}
        >
          <MaterialCommunityIcons
            name={running ? "stop-circle" : "play-circle"}
            size={20}
            color={running ? C.red : C.green}
          />
          <Text style={[s.bigBtnText, { color: running ? C.red : C.green }]}>
            {running ? "CLOSE" : "OPEN SHELL"}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handleClear}
          disabled={!running}
          style={[s.miniBtn, !running && { opacity: 0.4 }]}
        >
          <MaterialCommunityIcons name="broom" size={16} color={C.textDim} />
          <Text style={s.miniBtnText}>clear</Text>
        </TouchableOpacity>

        {/* Copy whole session scrollback to system clipboard — workaround
            for xterm.js + Android WebView's painful text-selection UX. */}
        <TouchableOpacity
          testID="btn-term-copy"
          onPress={handleCopy}
          disabled={!session || session.lines.length === 0}
          style={[s.miniBtn, (!session || session.lines.length === 0) && { opacity: 0.4 }]}
        >
          <MaterialCommunityIcons name="content-copy" size={16} color={C.cyan} />
          <Text style={[s.miniBtnText, { color: C.cyan }]}>copy</Text>
        </TouchableOpacity>

        {session && (
          <View style={s.statusPill}>
            <Text
              style={[
                s.statusText,
                {
                  color:
                    session.status === "running" ? C.green
                    : session.status === "starting" ? C.yellow
                    : session.status === "ended" ? C.textDim
                    : C.red,
                },
              ]}
            >
              {session.status}
              {session.pid ? ` · pid ${session.pid}` : ""}
            </Text>
          </View>
        )}
      </View>

      {/* xterm transcript */}
      {session ? (
        <View style={{ flex: 1 }}>
          <XTermView
            key={sessionId || "idle"}
            sessionId={sessionId}
            onInput={handleXTermInput}
            resetToken={sessionId || ""}
          />
        </View>
      ) : (
        <View style={s.idle}>
          <MaterialCommunityIcons name="console-line" size={40} color={C.textDim} />
          <Text style={s.idleText}>
            {"// persistent shell\n"}
            tap <Text style={{ color: C.green }}>OPEN SHELL</Text> to spawn{"\n"}
            <Text style={{ color: C.textDim }}>(zsh -l in PTY · state persists across tab switches)</Text>
          </Text>
          {execMode === "mock" && (
            <Text style={s.idleHint}>⚠ MOCK mode — switch to REAL or KALI first</Text>
          )}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
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
  idle: { flex: 1, alignItems: "center", justifyContent: "center", padding: 30 },
  idleText: { color: C.text, fontFamily: MONO, fontSize: 12, textAlign: "center", marginTop: 12, lineHeight: 18 },
  idleHint: { color: C.yellow, fontFamily: MONO, fontSize: 11, marginTop: 18, textAlign: "center" },
});
