/**
 * XTermView — true TUI terminal emulator for AI sessions.
 *
 * Hermes / CAI-Framework / pentestagent / etc. use Rich / Textual /
 * prompt-toolkit, which emit raw ANSI escape sequences (cursor positioning,
 * 256-color, hyperlinks, OSC titles, …) even in "plain" CLI mode. Our flat
 * <Text> scrollback can't render any of that. Instead we mount xterm.js
 * inside a WebView and pipe the session bytes through it.
 *
 * Architecture:
 *   • WebView hosts xterm.js + addon-fit (loaded from jsDelivr CDN — the
 *     NetHunter device generally has internet via wifi/tether; if we ever
 *     need fully offline, we'll vendor the JS as a base64 string).
 *   • RN → Web: webview.injectJavaScript('window.termWrite(<json>);') is
 *     called with each fresh batch of session lines (re-joined by \r\n so
 *     xterm sees one cohesive byte stream).
 *   • Web → RN: xterm.onData → ReactNativeWebView.postMessage(json) which
 *     we forward to writeStdin(sessionId, …).
 *
 * Theme intentionally matches the rest of the Enforcer UI (green-on-black
 * Kali palette) so the AI tab feels of a piece with Live / Terminal.
 */
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { sessionManager } from "../lib/sessionManager";

type Props = {
  /** The session we're rendering. May change as user starts/stops sessions. */
  sessionId: string | null;
  /** Forwarded to writeStdin when xterm emits a keystroke. */
  onInput: (data: string) => void;
  /** Optional: bumped by parent to force the WebView to re-mount (e.g. when
   *  user picks a different profile while a session was active). */
  resetToken?: string | number;
};

// xterm + fit-addon — pinned versions for reproducibility.
const XTERM_VER = "5.5.0";
const FIT_VER = "0.10.0";

/**
 * Inline HTML loaded into the WebView. Kept as a `const` (not a template
 * with interpolated values) so the bundler doesn't have to re-encode it on
 * every render — every re-render with the same `source.html` is treated
 * as identical by react-native-webview and won't reload.
 */
const XTERM_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@${XTERM_VER}/css/xterm.min.css" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; width: 100%; background: #04070a; overflow: hidden; }
  #t { width: 100%; height: 100vh; padding: 4px; box-sizing: border-box; }
  #boot { position: absolute; top: 8px; left: 8px; color: #6c8a82; font-family: monospace; font-size: 11px; }
  /* xterm injects a textarea for IME — make it invisible but focusable */
  .xterm-helper-textarea { opacity: 0; }
  .xterm-viewport { background-color: #04070a !important; }
</style>
</head>
<body>
<div id="boot">// loading xterm.js…</div>
<div id="t"></div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@${XTERM_VER}/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@${FIT_VER}/lib/addon-fit.min.js"></script>
<script>
(function () {
  // Helper that talks back to React Native.
  function post(msg) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(msg));
      }
    } catch (e) {}
  }

  // Guard against the scripts failing to load (offline, CDN down, …).
  if (typeof Terminal === "undefined") {
    document.getElementById("boot").innerText =
      "// xterm failed to load (no network?). Tap session info to switch to scrollback mode.";
    post({ type: "load_error", message: "xterm.min.js failed to load" });
    return;
  }

  // Theme: match the Enforcer palette so the AI terminal looks of a piece
  // with the rest of the app. Bright/dim colors mirror what a typical Kali
  // terminal emits, with our green/cyan accents nudged toward neon.
  var theme = {
    background: "#04070a",
    foreground: "#cfeadb",
    cursor: "#00ff66",
    cursorAccent: "#04070a",
    selectionBackground: "#163041",
    black: "#04070a",
    red: "#ff3860",
    green: "#00ff66",
    yellow: "#ffd400",
    blue: "#3ad7ff",
    magenta: "#ff5cdb",
    cyan: "#3ad7ff",
    white: "#cfeadb",
    brightBlack: "#6c8a82",
    brightRed: "#ff5680",
    brightGreen: "#5cffb1",
    brightYellow: "#ffe066",
    brightBlue: "#7ee0ff",
    brightMagenta: "#ff8be0",
    brightCyan: "#7ee0ff",
    brightWhite: "#ffffff"
  };

  var term = new Terminal({
    fontFamily: "Menlo, Consolas, Liberation Mono, monospace",
    fontSize: 12,
    lineHeight: 1.15,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: "block",
    scrollback: 5000,
    convertEol: false,
    allowProposedApi: true,
    macOptionIsMeta: true,
    rightClickSelectsWord: true,
    theme: theme
  });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);

  var el = document.getElementById("t");
  term.open(el);
  document.getElementById("boot").style.display = "none";

  function tryFit() {
    try {
      fit.fit();
      post({ type: "resize", cols: term.cols, rows: term.rows });
    } catch (e) {}
  }
  setTimeout(tryFit, 30);
  setTimeout(tryFit, 200);
  window.addEventListener("resize", tryFit);
  // Some Android WebViews don't fire 'resize' on rotation; observe layout.
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function () { tryFit(); });
    ro.observe(el);
  }

  // Public surface called by RN via injectJavaScript().
  window.termWrite = function (data) {
    try { term.write(data); } catch (e) {}
  };
  window.termWriteln = function (data) {
    try { term.writeln(data); } catch (e) {}
  };
  window.termClear = function () {
    try { term.clear(); term.reset(); } catch (e) {}
  };
  window.termFocus = function () {
    try { term.focus(); } catch (e) {}
  };
  window.termFit = tryFit;
  window.termReady = true;

  // Web → RN: keystrokes. Forward raw data — xterm already encodes
  // arrow keys, backspace, ctrl-c etc into the right escape sequences.
  term.onData(function (d) { post({ type: "data", data: d }); });
  // Forward terminal title changes for diagnostics.
  term.onTitleChange(function (t) { post({ type: "title", title: t }); });

  // Tell RN we're ready and what size we are; RN can now flush its
  // pending writes queue.
  post({ type: "ready", cols: term.cols, rows: term.rows });
})();
</script>
</body>
</html>`;

export default function XTermView({ sessionId, onInput, resetToken }: Props) {
  const webRef = useRef<WebView>(null);
  const readyRef = useRef(false);
  // Buffer writes that arrive before the WebView has finished loading
  // xterm.js — flushed once we get the `ready` message.
  const pendingRef = useRef<string[]>([]);
  // The last line_no we've forwarded to the terminal; we only ever push
  // forward (never re-write older lines) so the terminal sees a clean
  // append-only byte stream.
  const lastLineNoRef = useRef<number>(0);

  // Track whether we've ever written anything so the very first fresh
  // batch doesn't get a spurious leading blank line (there's nothing to
  // separate FROM if the initial replay was empty).
  const hasWrittenRef = useRef<boolean>(false);

  // ── RN → Web: write bytes ─────────────────────────────────────────────
  const writeToTerm = useCallback((data: string) => {
    if (!data) return;
    // JSON.stringify gives us a JS-safe quoted string with escapes intact —
    // CRITICAL for preserving \x1b (ESC) and other control bytes when we
    // bake the data into a JS snippet for injectJavaScript.
    const encoded = JSON.stringify(data);
    if (readyRef.current && webRef.current) {
      webRef.current.injectJavaScript(`window.termWrite && window.termWrite(${encoded}); true;`);
      hasWrittenRef.current = true;
    } else {
      pendingRef.current.push(data);
    }
  }, []);

  // ── Subscribe to session line stream ──────────────────────────────────
  useEffect(() => {
    if (!sessionId) {
      lastLineNoRef.current = 0;
      hasWrittenRef.current = false;
      return;
    }
    // Replay whatever the session already has in its ring buffer (it may
    // have been running before the user switched tabs back to AI).
    const s0 = sessionManager.sessions.get(sessionId);
    if (s0 && s0.lines.length) {
      // Join lines with \r\n between them but NO trailing terminator —
      // that used to double-space every batch because native's
      // line-splitter emits ALL PTY newlines as separate lines already
      // (including zsh's aesthetic blank line + prompt redraws), so
      // appending our own \r\n meant every command left 2-5 extra blank
      // rows before the next prompt. Now the last line's cursor lands
      // exactly where zsh intended it.
      const initial = s0.lines.map((l) => l.line).join("\r\n");
      writeToTerm(initial);
      lastLineNoRef.current = s0.lineCount;
    } else {
      lastLineNoRef.current = 0;
    }

    const unsub = sessionManager.subscribe(() => {
      const s = sessionManager.sessions.get(sessionId);
      if (!s) return;
      if (s.lineCount <= lastLineNoRef.current) return;
      const fresh = s.lines.filter((l) => l.line_no > lastLineNoRef.current);
      if (fresh.length) {
        // Prepend \r\n only if we've already written something. If this
        // is the very first write (initial replay was empty), no leading
        // separator is needed.
        const prefix = hasWrittenRef.current ? "\r\n" : "";
        const chunk = prefix + fresh.map((l) => l.line).join("\r\n");
        writeToTerm(chunk);
      }
      lastLineNoRef.current = s.lineCount;
    });
    return unsub;
    // resetToken intentionally in deps so a new session swaps the
    // subscription. writeToTerm is stable (memoized).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, resetToken]);

  // ── Web → RN: keystrokes + ready signal ───────────────────────────────
  const onMessage = useCallback((event: any) => {
    let msg: any = null;
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ready") {
      readyRef.current = true;
      // Flush anything that arrived before the WebView booted xterm.
      if (pendingRef.current.length && webRef.current) {
        const buf = pendingRef.current.join("");
        pendingRef.current = [];
        const encoded = JSON.stringify(buf);
        webRef.current.injectJavaScript(`window.termWrite && window.termWrite(${encoded}); true;`);
      }
    } else if (msg.type === "data") {
      // Raw keystroke (already a properly-encoded escape sequence for
      // arrows / function keys / ctrl-chars).
      onInput(msg.data);
    } else if (msg.type === "load_error") {
      // CDN failed — leave a note in the buffer so the user knows.
      // (Surfaced as a JS console log; future enhancement: hoist to RN UI.)
      console.warn("[XTermView] xterm.js failed to load in WebView:", msg.message);
    }
  }, [onInput]);

  // ── Inject focus when the component mounts/becomes visible ────────────
  // Keeps the soft-keyboard usable as soon as the user taps inside.
  const focusTerm = useCallback(() => {
    if (readyRef.current && webRef.current) {
      webRef.current.injectJavaScript(`window.termFocus && window.termFocus(); true;`);
    }
  }, []);

  // Stable source — never recompute (would force WebView reload).
  const source = useMemo(() => ({ html: XTERM_HTML, baseUrl: "https://cdn.jsdelivr.net" }), []);

  return (
    <View style={s.root} onTouchStart={focusTerm}>
      <WebView
        ref={webRef}
        originWhitelist={["*"]}
        source={source}
        onMessage={onMessage}
        javaScriptEnabled
        domStorageEnabled
        automaticallyAdjustContentInsets={false}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        style={s.web}
        androidLayerType="hardware"
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        mixedContentMode="always"
        setSupportMultipleWindows={false}
        // Performance: skip overdraw on Android, smoother text rendering.
        cacheEnabled
        cacheMode="LOAD_DEFAULT"
        // We render full-screen inside our own SafeAreaView already.
        contentInsetAdjustmentBehavior="never"
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#04070a" },
  web: {
    flex: 1,
    backgroundColor: "#04070a",
    // react-native-webview on Android sometimes flashes white on first
    // mount; this ensures the underlying View matches our dark palette.
    opacity: Platform.OS === "android" ? 0.999 : 1,
  },
});
