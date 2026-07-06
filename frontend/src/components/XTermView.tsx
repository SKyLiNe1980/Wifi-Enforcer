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
  //
  // Execute via indirect eval FIRST — many hardened Android WebViews silently
  // refuse to run dynamically-appended <script> elements (the same reason our
  // in-document <script> never fired), but injectedJavaScript's evaluate
  // context CAN eval. `(0, eval)(code)` runs in global scope so the xterm/fit
  // UMD bundles attach Terminal/FitAddon to window. Fall back to <script>
  // element injection only if eval throws.
  try {
    var xbSrc = atob(window.__XB || "");
    var fbSrc = atob(window.__FB || "");
    try {
      (0, eval)(xbSrc);
      (0, eval)(fbSrc);
      post({ type: "diag", stage: "lib-eval", detail: "Terminal=" + (typeof Terminal) });
    } catch (evalErr) {
      post({ type: "diag", stage: "eval-failed", detail: String(evalErr && evalErr.message || evalErr) });
      var s1 = document.createElement("script"); s1.text = xbSrc; document.head.appendChild(s1);
      var s2 = document.createElement("script"); s2.text = fbSrc; document.head.appendChild(s2);
    }
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
      window.__termCols = term.cols;
      window.__termRows = term.rows;
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
    try {
      // Defensive: if a whole event/payload object slips through, extract the
      // string it carries instead of writing "[object Object]".
      if (data && typeof data === "object") {
        data = (data.data != null ? data.data : (data.text != null ? data.text : ""));
      }
      if (typeof data !== "string") return;
      term.write(data);
    } catch (e) {}
  };
  // Raw byte path: RN sends the native PTY chunk as base64. We decode it to
  // a Uint8Array and hand xterm the exact bytes — xterm does its own
  // incremental UTF-8 decode and buffers partial multi-byte sequences across
  // calls, so \r cursor-resets, ANSI colors and full-screen TUIs render
  // correctly (unlike the old line-joined text path).
  window.termWriteB64 = function (b64) {
    try {
      // Defensive: unwrap an object payload (e.g. { dataB64 }, { data }) so a
      // caller that forwards the raw event object never renders as text.
      if (b64 && typeof b64 === "object") {
        b64 = b64.dataB64 || b64.data || "";
      }
      if (typeof b64 !== "string" || !b64) return;
      var bin = atob(b64);
      var len = bin.length;
      var u8 = new Uint8Array(len);
      for (var i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
      term.write(u8);
    } catch (e) {}
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
  // Let xterm OWN input. It handles IME/composition natively and already
  // encodes Enter→\\r, Backspace→\\x7f, Tab, arrows/F-keys→escape sequences,
  // and paste. The previous hand-rolled capture-phase textarea diffing was
  // the source of the double-char / lag / re-sent-buffer bugs — removed.
  // We just set sane mobile IME attributes and forward term.onData.
  var textarea = term.textarea;
  if (textarea) {
    textarea.setAttribute("autocorrect", "off");
    textarea.setAttribute("autocapitalize", "none");
    textarea.setAttribute("spellcheck", "false");
    textarea.setAttribute("autocomplete", "off");
    textarea.setAttribute("inputmode", "text");
  }
  term.onData(function (d) {
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
  // Buffer raw base64 chunks that arrive before the WebView has finished
  // loading xterm.js — flushed once we get the `ready` message.
  const pendingRef = useRef<string[]>([]);
  // Mirror sessionId / fallback into refs so the stable onMessage callback
  // can read them without being re-created (which would re-mount listeners).
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;
  const fallbackRef = useRef<boolean>(false);
  // Interval that polls the WebView for boot success (window.termReady) and
  // re-announces `ready`, so a dropped ready postMessage never strands us.
  const bootPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── RN → Web: write raw PTY bytes ─────────────────────────────────────
  // Native relays the exact PTY byte stream as base64; we forward it as-is
  // to the WebView which decodes + term.write()s the bytes. No line joining,
  // no \r\n synthesis, no blank-run collapsing — the terminal emulator owns
  // interpretation, which is the whole point of a true PTY relay.
  const writeRawB64 = useCallback((chunk: any) => {
    // Defensive extraction: accept a plain base64 string, or an event/payload
    // object ({ dataB64 } from native, { data }, { b64 }) — never forward a
    // raw object to the WebView (that's what rendered as "[object Object]").
    let b64: string | undefined;
    if (typeof chunk === "string") b64 = chunk;
    else if (chunk && typeof chunk === "object") b64 = chunk.dataB64 || chunk.data || chunk.b64;
    if (!b64 || typeof b64 !== "string") return;
    const encoded = JSON.stringify(b64);
    if (readyRef.current && webRef.current) {
      webRef.current.injectJavaScript(`window.termWriteB64 && window.termWriteB64(${encoded}); true;`);
    } else {
      pendingRef.current.push(b64);
    }
  }, []);

  // Flip to the flat scrollback fallback (xterm failed to boot / crashed)
  // and prime it with whatever text we've derived so far.
  const enterFallback = useCallback(() => {
    fallbackRef.current = true;
    const sid = sessionIdRef.current;
    if (sid) {
      const s = sessionManager.sessions.get(sid);
      if (s) setFbLines(s.lines.map((l) => l.line).join("\n"));
    }
    setFallback(true);
  }, []);

  // ── Boot watchdog ─────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    // If xterm hasn't signalled `ready` within 8s, the WebView failed to
    // boot → switch to flat scrollback so it's never a dead screen. The flat
    // view still shows real output (lines derived from the raw chunks).
    const t = setTimeout(() => {
      if (alive && !readyRef.current) enterFallback();
    }, 8000);
    return () => {
      alive = false;
      clearTimeout(t);
      if (bootPollRef.current) { clearInterval(bootPollRef.current); bootPollRef.current = null; }
    };
  }, [enterFallback]);

  // Flip readiness the moment xterm is mounted and flush any queued chunks.
  // CRITICAL: readiness must NOT depend on the data stream (the old build's
  // bug — its ready flag was gated on the discrete line-array event, so once
  // native switched to raw chunks it never toggled and the terminal hung on
  // the boot screen forever). We drive readiness purely from the boot
  // lifecycle: injectJavaScript calls are serialized in the WebView JS queue,
  // so by the time these flushed writes execute, the boot script (injected
  // just before) has already created `term` + defined window.termWriteB64.
  const markReadyAndFlush = useCallback(() => {
    if (readyRef.current) return;
    readyRef.current = true;
    if (bootPollRef.current) { clearInterval(bootPollRef.current); bootPollRef.current = null; }
    setDiag((d) => (d && d.startsWith("xterm ready") ? d : "xterm ready"));
    const web = webRef.current;
    if (web && pendingRef.current.length) {
      const buf = pendingRef.current;
      pendingRef.current = [];
      for (const b64 of buf) {
        web.injectJavaScript(`window.termWriteB64 && window.termWriteB64(${JSON.stringify(b64)}); true;`);
      }
    }
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

    // CONFIRM boot success — never assume it. The boot script sets
    // window.termReady=true ONLY after `new Terminal()` + term.open() succeed.
    // We poll for that flag and re-announce `ready` (the initial postMessage
    // can be dropped on flaky WebViews). If the terminal genuinely never boots
    // (e.g. the WebView refuses to eval the xterm bundle), readyRef stays
    // false and the watchdog drops us to the flat scrollback fallback — which
    // still shows real output derived from the raw chunks. Never a permanent
    // "booting…" screen (the previous unconditional flip removed that safety).
    let attempts = 0;
    if (bootPollRef.current) clearInterval(bootPollRef.current);
    bootPollRef.current = setInterval(() => {
      attempts += 1;
      const w = webRef.current;
      if (!w || readyRef.current || attempts > 40) {
        if (bootPollRef.current) { clearInterval(bootPollRef.current); bootPollRef.current = null; }
        return;
      }
      w.injectJavaScript(
        `(function(){try{ if(window.termReady && window.ReactNativeWebView){ window.ReactNativeWebView.postMessage(JSON.stringify({type:"ready", cols:(window.__termCols||0), rows:(window.__termRows||0)})); } }catch(e){}})(); true;`,
      );
    }, 250);
  }, []);


  useEffect(() => {
    if (!sessionId) return;
    // Replay the raw byte scrollback so a tab-switch re-mount restores the
    // screen (the session keeps running in the background; only the WebView
    // was torn down). Each chunk is written as its own decode+write so
    // independently-base64'd chunks don't need to be concatenation-valid.
    const log = sessionManager.getRawLog(sessionId);
    for (const c of log) writeRawB64(c.b64);
    // Prime the flat fallback text once.
    const s0 = sessionManager.sessions.get(sessionId);
    if (s0) setFbLines(s0.lines.map((l) => l.line).join("\n"));

    // Live: forward every new raw chunk straight into xterm.
    const unsubRaw = sessionManager.subscribeRaw(sessionId, (b64) => writeRawB64(b64));
    // Keep the flat fallback in sync — but only pay the join cost when the
    // fallback view is actually active (xterm failed to boot).
    const unsub = sessionManager.subscribe(() => {
      if (!fallbackRef.current) return;
      const s = sessionManager.sessions.get(sessionId);
      if (s) setFbLines(s.lines.map((l) => l.line).join("\n"));
    });
    return () => { unsubRaw(); unsub(); };
    // resetToken in deps so a new session swaps the subscription.
    // writeRawB64 is stable (memoized).
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
      // Boot lifecycle already flipped readiness in bootXterm; this message
      // is now just the authoritative cols/rows. markReadyAndFlush is
      // idempotent, so call it too in case bootXterm hasn't run yet (e.g. the
      // WebView posted ready via its own path first).
      markReadyAndFlush();
      setDiag(`xterm ready · ${msg.cols}x${msg.rows}`);
      // Tell the PTY our real size right away.
      if (sessionIdRef.current && msg.cols && msg.rows) {
        sessionManager.resize(sessionIdRef.current, msg.cols, msg.rows);
      }
    } else if (msg.type === "resize") {
      // xterm re-fit (rotation / keyboard / layout). Reflow the PTY so
      // full-screen apps and prompt wrapping match the visible width.
      if (sessionIdRef.current && msg.cols && msg.rows) {
        sessionManager.resize(sessionIdRef.current, msg.cols, msg.rows);
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
  }, [onInput, markReadyAndFlush]);

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
        onError={(e) => { setDiag(`webview onError: ${e?.nativeEvent?.description || ""}`); enterFallback(); }}
        onHttpError={(e) => setDiag(`http ${e?.nativeEvent?.statusCode || "?"}`)}
        onLoadEnd={() => { setDiag((d) => d || "html loaded, streaming xterm…"); bootXterm(); }}
        onRenderProcessGone={() => { setDiag("webview process gone"); enterFallback(); }}
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
