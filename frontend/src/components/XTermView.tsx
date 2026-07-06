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
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, StyleSheet, View, ScrollView, Text, TextInput } from "react-native";
import { WebView } from "react-native-webview";
import { sessionManager } from "../lib/sessionManager";

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });
// Vendored xterm.js payload — see frontend/scripts/vendor-xterm.sh.
// Loading from a public CDN inside the WebView hangs indefinitely on
// tailnet-routed devices (the exit node may not have a route to
// jsDelivr, or the chroot's resolver misses the alias). Bundling the
// JS + CSS as base64 inside a JSON asset lets Metro ship it with the
// app bundle so the terminal loads even fully offline.
const xtermBundle = require("../../assets/xterm/xterm-bundle.json") as {
  xtermVersion: string;
  fitVersion: string;
  cssContent: string;
  xtermJsB64: string;
  fitAddonB64: string;
};

type Props = {
  /** The session we're rendering. May change as user starts/stops sessions. */
  sessionId: string | null;
  /** Forwarded to writeStdin when xterm emits a keystroke. */
  onInput: (data: string) => void;
  /** Optional: bumped by parent to force the WebView to re-mount (e.g. when
   *  user picks a different profile while a session was active). */
  resetToken?: string | number;
};

/**
 * Collapse runs of ≥2 consecutive empty strings down to a single empty
 * string. Rationale: the native line-splitter emits an entry for every
 * `\n` in the PTY byte stream, including the ones zsh sprinkles for
 * aesthetic vertical spacing around its prompt and the ones inside
 * bracketed-paste toggles. Rejoining them naively produces walls of
 * blank vertical space between commands (5+ blank rows was the
 * observed baseline on Kali's default zsh setup). We preserve single
 * intentional blank lines (harmless) but cap consecutive-empty runs at
 * one so the terminal reads like an actual terminal.
 */
function collapseBlankRuns(lines: string[]): string[] {
  const out: string[] = [];
  let prevEmpty = false;
  for (const l of lines) {
    const isEmpty = l.length === 0;
    if (isEmpty && prevEmpty) continue; // drop
    out.push(l);
    prevEmpty = isEmpty;
  }
  return out;
}

/**
 * Strip ANSI/VT escape sequences (SGR colors, cursor moves, OSC titles,
 * bracketed-paste, charset selects, and lone control bytes) so the flat
 * scrollback fallback shows clean readable text instead of raw `[0m[01;34m`
 * noise. Only used by the fallback view — the real xterm path keeps the
 * raw bytes so it can render true color/TUI.
 */
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * Inline HTML loaded into the WebView. Kept as a `const` (not a template
 * with interpolated values) so the bundler doesn't have to re-encode it on
 * every render — every re-render with the same `source.html` is treated
 * as identical by react-native-webview and won't reload.
 *
 * All external assets are inlined from the vendored bundle: xterm.min.css
 * as raw text inside a <style> block, xterm.min.js and addon-fit.min.js
 * as base64 strings that a small bootstrap script decodes with atob()
 * and evaluates. No network requests leave the WebView.
 */
const XTERM_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
${xtermBundle.cssContent}
</style>
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
<div id="boot">// booting xterm.js…</div>
<div id="t"></div>
</body>
</html>`;

// The entire terminal boot runs through injectedJavaScript, NOT page
// <script> tags. Diagnostics proved this device's WebView does not execute
// in-document <script> (inline OR file:// src) — "html loaded" fires but no
// bootstrap runs. react-native-webview's injectedJavaScript uses the native
// evaluateJavascript bridge, which DOES run reliably. We decode the vendored
// xterm + fit base64 with atob() and append them as script elements (that
// executes them synchronously in global scope), then boot xterm.
const XTERM_BOOT_JS = `
(function () {
  function post(msg) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(msg));
      }
    } catch (e) {}
  }
  if (window.__enforcerTermBooted) return; // injectedJavaScript can run twice
  window.__enforcerTermBooted = true;

  window.onerror = function (m, src, line, col, err) {
    post({ type: "diag", stage: "window.onerror", detail: String(m) + " @" + line + ":" + col });
    return false;
  };
  post({ type: "diag", stage: "inject-start", detail: "atob=" + (typeof atob) });

  // Decode + execute xterm.js and the fit addon. The base64 was streamed
  // into window.__XB / window.__FB in small chunks (Android evaluateJavascript
  // drops payloads that are too large in a single shot).
  try {
    var s1 = document.createElement("script"); s1.text = atob(window.__XB || ""); document.head.appendChild(s1);
    var s2 = document.createElement("script"); s2.text = atob(window.__FB || ""); document.head.appendChild(s2);
  } catch (e) {
    post({ type: "load_error", message: "inject failed: " + (e && e.message || e) });
    return;
  }
  post({ type: "diag", stage: "lib-injected", detail: "Terminal=" + (typeof Terminal) + " FitAddon=" + (typeof FitAddon) });

  if (typeof Terminal === "undefined") {
    post({ type: "load_error", message: "Terminal undefined after inject" });
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

  // ── Web → RN: keystrokes ────────────────────────────────────────────
  //
  // On Android WebViews the soft keyboard (Samsung/Gboard/SwiftKey) does
  // not always dispatch individual keystrokes — it uses IME composition
  // which xterm.js interprets by reading the helper <textarea> value.
  // In practice this leads to two failure modes we hit on the S10+:
  //
  //   • The textarea is never cleared between commands, so every Enter
  //     re-sends the whole accumulated buffer ("i" → "idid" → "ididls"…).
  //   • Local echo appears delayed / invisible while typing because IME
  //     is still composing and hasn't dispatched anything to xterm.
  //
  // Fix: bypass xterm's built-in input pipeline entirely. We attach our
  // own capture-phase listeners on the helper textarea and:
  //   1. Handle Enter / Backspace / Tab immediately via keydown (Android
  //      IMEs fire keydown for these reliably, even during composition).
  //   2. On every 'input' event, compute the delta beyond the last
  //      known value, post it to RN, and clear the textarea so nothing
  //      accumulates.
  //   3. Suppress xterm's own onData for typed input (paste + programmatic
  //      writes still work through term.paste()).
  //
  // This preserves ANSI escape encoding for arrow / function keys (still
  // handled by xterm's keydown → onKey → onData path for non-printable
  // keys we didn't preventDefault on).
  var textarea = term.textarea;
  if (textarea) {
    textarea.setAttribute("autocorrect", "off");
    textarea.setAttribute("autocapitalize", "none");
    textarea.setAttribute("spellcheck", "false");
    textarea.setAttribute("autocomplete", "off");
    textarea.setAttribute("inputmode", "text");

    var lastVal = "";

    textarea.addEventListener("keydown", function (e) {
      // Enter → \r (shell newline). Prevent default so IME doesn't
      // ALSO commit a "\n" via the input event.
      if (e.key === "Enter" || e.keyCode === 13) {
        e.preventDefault();
        e.stopImmediatePropagation();
        post({ type: "data", data: "\\r" });
        textarea.value = "";
        lastVal = "";
        return;
      }
      // Backspace → DEL (0x7f) as most PTYs expect.
      if (e.key === "Backspace" || e.keyCode === 8) {
        e.preventDefault();
        e.stopImmediatePropagation();
        post({ type: "data", data: "\\x7f" });
        textarea.value = "";
        lastVal = "";
        return;
      }
      // Tab → literal tab. Prevent default so focus doesn't escape.
      if (e.key === "Tab" || e.keyCode === 9) {
        e.preventDefault();
        e.stopImmediatePropagation();
        post({ type: "data", data: "\\t" });
        textarea.value = "";
        lastVal = "";
        return;
      }
    }, true);

    // Printable text via IME / regular typing. This fires per-composition
    // update on Android, so we must diff + clear every time.
    textarea.addEventListener("input", function (e) {
      var v = textarea.value;
      if (!v) return;
      // Compute delta beyond whatever we already sent this composition.
      var delta;
      if (v.length > lastVal.length && v.indexOf(lastVal) === 0) {
        delta = v.substring(lastVal.length);
      } else {
        // Backwards/replace/paste — send the whole buffer.
        delta = v;
      }
      if (delta) {
        post({ type: "data", data: delta });
      }
      // Aggressively clear so the next keystroke can't re-send old chars.
      textarea.value = "";
      lastVal = "";
      // Prevent xterm's internal handler from also processing this event.
      e.stopImmediatePropagation();
    }, true);

    // Compositionend as a safety net — some IMEs commit here without
    // firing input.
    textarea.addEventListener("compositionend", function () {
      textarea.value = "";
      lastVal = "";
    }, true);
  }

  // Non-printable keys (arrows, F-keys, Ctrl-C, etc.) still flow through
  // xterm's onData because we did NOT preventDefault them above. Those
  // don't go through the textarea's input event on Android.
  term.onData(function (d) {
    // Guard: skip empty payloads that could sneak through from IME.
    if (!d) return;
    post({ type: "data", data: d });
  });
  // Forward terminal title changes for diagnostics.
  term.onTitleChange(function (t) { post({ type: "title", title: t }); });

  // Tell RN we're ready and what size we are; RN can now flush its
  // pending writes queue.
  post({ type: "ready", cols: term.cols, rows: term.rows });
})();
true;
`;

export default function XTermView({ sessionId, onInput, resetToken }: Props) {
  const webRef = useRef<WebView>(null);
  const readyRef = useRef(false);
  // If xterm never signals ready, drop to a flat scrollback so the
  // terminal is usable instead of frozen on the boot screen.
  const [fallback, setFallback] = useState(false);
  const [fbLines, setFbLines] = useState<string>("");
  const [fbInput, setFbInput] = useState<string>("");
  const fbScrollRef = useRef<ScrollView>(null);
  // Diagnostic line surfaced from the WebView (why xterm did/didn't boot).
  const [diag, setDiag] = useState<string>("");
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

  // ── Boot watchdog ─────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    // If xterm hasn't signalled `ready` within 12s, the WebView failed to
    // boot → switch to flat scrollback so it's never a dead screen.
    const t = setTimeout(() => {
      if (alive && !readyRef.current) setFallback(true);
    }, 12000);
    return () => { alive = false; clearTimeout(t); };
  }, []);

  // Stream the xterm/fit base64 into the WebView in small chunks, then run
  // the boot script. Android's evaluateJavascript silently drops a single
  // huge payload (that's why injectedJavaScript with the inlined base64
  // never fired), but many small imperative injectJavaScript() calls work.
  const bootedRef = useRef(false);
  const bootXterm = useCallback(() => {
    const web = webRef.current;
    if (!web || bootedRef.current) return;
    bootedRef.current = true;
    const CHUNK = 8000;
    web.injectJavaScript(`window.__XB="";window.__FB="";true;`);
    const feed = (b64: string, name: string) => {
      for (let i = 0; i < b64.length; i += CHUNK) {
        const part = b64.slice(i, i + CHUNK);
        web.injectJavaScript(`window.${name}+=${JSON.stringify(part)};true;`);
      }
    };
    feed(xtermBundle.xtermJsB64, "__XB");
    feed(xtermBundle.fitAddonB64, "__FB");
    web.injectJavaScript(XTERM_BOOT_JS);
  }, []);


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
      const initial = collapseBlankRuns(s0.lines.map((l) => l.line)).join("\r\n");
      writeToTerm(initial);
      setFbLines(collapseBlankRuns(s0.lines.map((l) => l.line)).join("\n"));
      lastLineNoRef.current = s0.lineCount;
    } else {
      setFbLines("");
      lastLineNoRef.current = 0;
    }

    const unsub = sessionManager.subscribe(() => {
      const s = sessionManager.sessions.get(sessionId);
      if (!s) return;
      if (s.lineCount <= lastLineNoRef.current) return;
      const fresh = s.lines.filter((l) => l.line_no > lastLineNoRef.current);
      if (fresh.length) {
        const prefix = hasWrittenRef.current ? "\r\n" : "";
        const chunk = prefix + collapseBlankRuns(fresh.map((l) => l.line)).join("\r\n");
        writeToTerm(chunk);
        // Keep the flat scrollback (fallback view) in sync too.
        setFbLines(collapseBlankRuns(s.lines.map((l) => l.line)).join("\n"));
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
      setDiag(`xterm ready · ${msg.cols}x${msg.rows}`);
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
    } else if (msg.type === "diag") {
      setDiag(`${msg.stage}: ${msg.detail || ""}`);
    } else if (msg.type === "load_error") {
      setDiag(`load_error: ${msg.message}`);
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

  // Stable source — tiny inline skeleton; xterm boots via injectedJavaScript.
  const source = useMemo(() => ({ html: XTERM_HTML, baseUrl: "https://localhost/" }), []);

  const submitFallback = useCallback(() => {
    // Line-based input for the scrollback fallback (no PTY key handling).
    onInput(fbInput + "\r");
    setFbInput("");
  }, [fbInput, onInput]);

  // ── Flat scrollback fallback (xterm didn't boot) ──────────────────────
  if (fallback) {
    return (
      <View style={s.root}>
        {diag ? (
          <View style={s.diagBar}>
            <Text style={s.diagText} numberOfLines={2}>{`⚠ xterm didn't boot · ${diag}`}</Text>
          </View>
        ) : null}
        <ScrollView
          ref={fbScrollRef}
          style={s.fbScroll}
          contentContainerStyle={s.fbContent}
          onContentSizeChange={() => fbScrollRef.current?.scrollToEnd({ animated: false })}
        >
          <Text style={s.fbText} selectable>{stripAnsi(fbLines) || "// terminal ready — type a command below"}</Text>
        </ScrollView>
        <View style={s.fbInputRow}>
          <Text style={s.fbPrompt}>$</Text>
          <TextInput
            style={s.fbInput}
            value={fbInput}
            onChangeText={setFbInput}
            onSubmitEditing={submitFallback}
            placeholder="command…"
            placeholderTextColor="#3c5a52"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            blurOnSubmit={false}
            returnKeyType="send"
          />
        </View>
      </View>
    );
  }

  return (
    <View style={s.root} onTouchStart={focusTerm}>
      <WebView
        ref={webRef}
        originWhitelist={["*"]}
        source={source}
        injectedJavaScriptBeforeContentLoaded={`try{window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:"diag",stage:"inject-before"}));}catch(e){} true;`}
        onMessage={onMessage}
        onError={(e) => { setDiag(`webview onError: ${e?.nativeEvent?.description || ""}`); setFallback(true); }}
        onHttpError={(e) => setDiag(`http ${e?.nativeEvent?.statusCode || "?"}`)}
        onLoadEnd={() => { setDiag((d) => d || "html loaded, streaming xterm…"); bootXterm(); }}
        onRenderProcessGone={() => { setDiag("webview process gone"); setFallback(true); }}
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
        cacheEnabled
        cacheMode="LOAD_DEFAULT"
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
    opacity: Platform.OS === "android" ? 0.999 : 1,
  },
  fbScroll: { flex: 1, backgroundColor: "#04070a" },
  fbContent: { padding: 8 },
  diagBar: { backgroundColor: "#2a0e0e", borderBottomWidth: 1, borderBottomColor: "#ff3860", paddingHorizontal: 8, paddingVertical: 5 },
  diagText: { fontFamily: MONO, fontSize: 10, color: "#ff8090" },
  fbText: { fontFamily: MONO, fontSize: 12, color: "#cfeadb", lineHeight: 17 },
  fbInputRow: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: "#163041",
    paddingHorizontal: 8,
    backgroundColor: "#0a1116",
  },
  fbPrompt: { fontFamily: MONO, fontSize: 13, color: "#00ff66", marginRight: 6 },
  fbInput: {
    flex: 1,
    fontFamily: MONO,
    fontSize: 13,
    color: "#cfeadb",
    paddingVertical: 10,
  },
});
