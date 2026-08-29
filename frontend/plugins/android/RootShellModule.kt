package com.wifienforcer.rootshell

import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.BufferedReader
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.InputStream
import java.io.InputStreamReader
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Native bridge that pipes shell commands through `su -c` on a rooted Android device.
 * Exposed to JS as: NativeModules.RootShell
 *
 * Synchronous methods (legacy, blocking):
 *   isRoot(): Promise<boolean>
 *   exec(cmd: String): Promise<{command, stdout, stderr, exit_code, duration_ms}>
 *   execBatch(cmds): Promise<{logs, duration_ms}>
 *
 * Streaming methods (NEW — for long-running tools like airodump-ng, wifite, tcpdump):
 *   executeStream(sessionId: String, command: String): Promise<sessionId>
 *      Emits events via DeviceEventEmitter:
 *        "RootShell.line"   {sessionId, stream:"stdout"|"stderr", line, lineNo}
 *        "RootShell.exit"   {sessionId, exit_code, duration_ms, lineCount}
 *        "RootShell.error"  {sessionId, message}
 *   killSession(sessionId: String, graceful: Boolean): Promise<boolean>
 *      graceful=true: send SIGINT, wait 2000ms, escalate to SIGKILL if still alive.
 *      graceful=false: SIGKILL immediately.
 *   listSessions(): Promise<Array<{sessionId, command, pid, started_at, line_count}>>
 *
 * SAFETY: assumes the device is rooted. Does NOT escalate privileges itself.
 */
class RootShellModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "RootShell"

    // ------------------------------------------------------------------
    // Session bookkeeping
    // ------------------------------------------------------------------
    private data class Session(
        val id: String,
        val command: String,
        val proc: Process,
        val startedAt: Long,
        // NOTE: previously had @Volatile on these — that annotation on data-class
        // primary-constructor params can trip stricter Kotlin compiler modes (it
        // targets the param, not the backing field, without @field:Volatile).
        // We don't strictly need volatile semantics here — pid is written once
        // (from the reader thread, when __WE_PID__ marker is parsed), and
        // `ended` is best-effort. JVM happens-before for short-lived threads
        // is enough for our purposes.
        var pid: Int? = null,
        val lineCount: AtomicInteger = AtomicInteger(0),
        var ended: Boolean = false,
        // ----------------------------------------------------------------
        // RAW BYTE BUFFERS — accumulate the exact PTY byte stream on the
        // reader threads and flush as a single base64 RootShell.chunk event
        // every ~80ms (or eagerly at a 64 KiB high-watermark). We MUST NOT
        // use BufferedReader.readLine() here: it strips carriage returns
        // (`\r`) and invents line boundaries, which destroys zsh/p10k prompt
        // redraws and full-screen TUI apps (vim/htop). A true PTY relay has
        // to transmit raw bytes so xterm.js can interpret the cursor/escape
        // sequences itself. Batching still bounds the RN bridge cost on
        // dmesg-style bursts (see crash log 2026-05-29: 184% CPU → ANR).
        // ----------------------------------------------------------------
        val stdoutBytes: ByteArrayOutputStream = ByteArrayOutputStream(8192),
        val stderrBytes: ByteArrayOutputStream = ByteArrayOutputStream(2048),
        // PID-marker preamble parser state (stdout only). Before the first
        // `__WE_PID__<pid>\n` line is consumed we buffer stdout here so we
        // can strip that marker line before forwarding real output. `exec`
        // hands the pipe off to the user's command afterward.
        val preamble: ByteArrayOutputStream = ByteArrayOutputStream(64),
        var pidCaptured: Boolean = false,
    )

    private val sessions = ConcurrentHashMap<String, Session>()

    // ------------------------------------------------------------------
    // Output-batching scheduler
    // ------------------------------------------------------------------
    // A single daemon thread drains every session's buffered lines every
    // FLUSH_INTERVAL_MS into a single RootShell.lines event per stream.
    // The reader threads (one per fd) push into per-session ArrayLists
    // under that buffer's intrinsic lock; the flusher swaps the list out
    // and emits in one bridge call. Reader threads ALSO eager-flush at
    // FLUSH_HIGH_WATERMARK lines to bound peak memory on dmesg-style
    // bursts (~30k lines instantly).
    private val flusher: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "rootshell-flusher").apply { isDaemon = true }
    }

    init {
        flusher.scheduleAtFixedRate(
            {
                try { flushAllSessions() } catch (e: Exception) { Log.w(TAG, "scheduled flush failed", e) }
            },
            FLUSH_INTERVAL_MS, FLUSH_INTERVAL_MS, TimeUnit.MILLISECONDS,
        )
    }

    private fun flushAllSessions() {
        // Snapshot of session refs — values() iterator is weakly consistent on
        // ConcurrentHashMap which is fine; missing a brand-new session for one
        // tick is acceptable, it will catch up next tick.
        for (s in sessions.values) flushSession(s)
    }

    private fun flushSession(s: Session) {
        val outBatch: ByteArray? = synchronized(s.stdoutBytes) {
            if (s.stdoutBytes.size() == 0) null
            else {
                val copy = s.stdoutBytes.toByteArray()
                s.stdoutBytes.reset()
                copy
            }
        }
        val errBatch: ByteArray? = synchronized(s.stderrBytes) {
            if (s.stderrBytes.size() == 0) null
            else {
                val copy = s.stderrBytes.toByteArray()
                s.stderrBytes.reset()
                copy
            }
        }
        if (outBatch != null) emitChunk(s, "stdout", outBatch)
        if (errBatch != null) emitChunk(s, "stderr", errBatch)
    }

    /**
     * Emit a raw byte chunk to JS, base64-encoded. Base64 (not putString on a
     * decoded String) is deliberate: the PTY byte stream can contain partial
     * multi-byte UTF-8 sequences at chunk boundaries and arbitrary control
     * bytes; base64 round-trips them losslessly so xterm.js can do its own
     * incremental UTF-8 decoding on the JS/WebView side.
     */
    private fun emitChunk(s: Session, label: String, bytes: ByteArray) {
        val m = Arguments.createMap()
        m.putString("sessionId", s.id)
        m.putString("stream", label)
        m.putString("dataB64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        m.putInt("bytes", bytes.size)
        emit(EVT_CHUNK, m)
    }

    private fun emit(event: String, params: WritableMap) {
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                ?.emit(event, params)
        } catch (e: Exception) {
            Log.w(TAG, "emit($event) failed", e)
        }
    }

    // RN's NativeEventEmitter stubs were here — moved to the END of the class
    // as a defensive measure. See bottom of file.

    // ------------------------------------------------------------------
    // Legacy synchronous API
    // ------------------------------------------------------------------
    @ReactMethod
    fun isRoot(promise: Promise) {
        try {
            val p = Runtime.getRuntime().exec(arrayOf("su", "-c", "id"))
            val ok = p.waitFor() == 0
            val out = p.inputStream.bufferedReader().readText()
            promise.resolve(ok && out.contains("uid=0"))
        } catch (e: Exception) {
            Log.w(TAG, "isRoot failed", e)
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun exec(command: String, promise: Promise) {
        val started = System.currentTimeMillis()
        try {
            val proc = Runtime.getRuntime().exec(arrayOf("su"))
            val stdin = DataOutputStream(proc.outputStream)
            stdin.writeBytes("$command\n")
            stdin.writeBytes("exit\n")
            stdin.flush()

            val stdout = BufferedReader(InputStreamReader(proc.inputStream)).readText()
            val stderr = BufferedReader(InputStreamReader(proc.errorStream)).readText()
            val code = proc.waitFor()
            val dur = System.currentTimeMillis() - started

            val map = Arguments.createMap()
            map.putString("command", command)
            map.putString("stdout", stdout)
            map.putString("stderr", stderr)
            map.putInt("exit_code", code)
            map.putInt("duration_ms", dur.toInt())
            promise.resolve(map)
        } catch (e: Exception) {
            Log.e(TAG, "exec failed: $command", e)
            promise.reject("ROOT_EXEC_ERR", e.message ?: "unknown", e)
        }
    }

    @ReactMethod
    fun execBatch(commands: com.facebook.react.bridge.ReadableArray, promise: Promise) {
        val started = System.currentTimeMillis()
        try {
            val proc = Runtime.getRuntime().exec(arrayOf("su"))
            val stdin = DataOutputStream(proc.outputStream)
            val markerBegin = "__WE_BEG__"
            val markerEnd = "__WE_END__"
            val n = commands.size()
            for (i in 0 until n) {
                val c = commands.getString(i) ?: ""
                stdin.writeBytes("echo $markerBegin$i\n")
                stdin.writeBytes("$c\n")
                stdin.writeBytes("echo $markerEnd$i:$?\n")
            }
            stdin.writeBytes("exit\n")
            stdin.flush()

            val stdout = BufferedReader(InputStreamReader(proc.inputStream)).readText()
            proc.waitFor()
            val results = Arguments.createArray()
            for (i in 0 until n) {
                val begin = stdout.indexOf("$markerBegin$i")
                val end = stdout.indexOf("$markerEnd$i:")
                val body = if (begin >= 0 && end > begin)
                    stdout.substring(begin + markerBegin.length + i.toString().length, end).trim()
                else ""
                val codeStr = if (end >= 0)
                    stdout.substring(end + markerEnd.length + i.toString().length + 1)
                        .lineSequence().firstOrNull()?.trim() ?: "0"
                else "0"
                val r = Arguments.createMap()
                r.putString("command", commands.getString(i) ?: "")
                r.putString("stdout", body)
                r.putString("stderr", "")
                r.putInt("exit_code", codeStr.toIntOrNull() ?: 0)
                results.pushMap(r)
            }
            val resp = Arguments.createMap()
            resp.putArray("logs", results)
            resp.putInt("duration_ms", (System.currentTimeMillis() - started).toInt())
            promise.resolve(resp)
        } catch (e: Exception) {
            Log.e(TAG, "execBatch failed", e)
            promise.reject("ROOT_EXEC_ERR", e.message ?: "unknown", e)
        }
    }

    // ------------------------------------------------------------------
    // Streaming API
    // ------------------------------------------------------------------

    /**
     * Spawn `su` and stream stdout/stderr line-by-line back to JS via events.
     * The shell first echoes its own PID so we can SIGINT/SIGKILL the right
     * process group. We `exec` the user's command so the PID we captured
     * remains the command's PID after the shell hands off.
     */
    @ReactMethod
    fun executeStream(sessionId: String, command: String, promise: Promise) {
        if (sessions.containsKey(sessionId)) {
            promise.reject("ROOT_SESSION_EXISTS", "session $sessionId already running")
            return
        }
        try {
            val proc = Runtime.getRuntime().exec(arrayOf("su"))
            val session = Session(
                id = sessionId,
                command = command,
                proc = proc,
                startedAt = System.currentTimeMillis(),
            )
            sessions[sessionId] = session

            val stdin = DataOutputStream(proc.outputStream)
            // Capture PID then replace the shell with the user command via `exec`.
            // After `exec`, the PID is preserved — so SIGINT to the captured PID hits
            // the user's command (e.g. airodump-ng) directly. Tools like wifite that
            // spawn children (aircrack-ng) handle SIGINT and cascade-clean their kids.
            // stdout (fd 1) and stderr (fd 2) are drained separately by reader threads.
            stdin.writeBytes("echo __WE_PID__\$\$\n")
            stdin.writeBytes("exec $command\n")
            stdin.flush()

            // Raw byte-stream reader threads (one per fd). See readStreamRaw.
            // Keep refs so the waiter can JOIN them before the final flush —
            // otherwise trailing bytes from quick-exit commands land in a
            // removed session and get dropped (the exit-tail race).
            val outReader = Thread({ readStreamRaw(session, proc.inputStream, "stdout") },
                "rootshell-stdout-$sessionId")
            val errReader = Thread({ readStreamRaw(session, proc.errorStream, "stderr") },
                "rootshell-stderr-$sessionId")
            outReader.start()
            errReader.start()

            // Waiter
            Thread({
                try {
                    val code = proc.waitFor()
                    val dur = (System.currentTimeMillis() - session.startedAt).toInt()
                    session.ended = true
                    // Drain fully: readers break at EOF once the pipes close.
                    // JOIN them BEFORE flushing so every last byte (e.g. the
                    // one-shot output of `agy --help`) is in the buffer.
                    try { outReader.join(2000) } catch (_: InterruptedException) {}
                    try { errReader.join(2000) } catch (_: InterruptedException) {}
                    // Flush any trailing buffered lines BEFORE the exit event so
                    // JS sees all output before it sees "ended" status.
                    flushSession(session)
                    val m = Arguments.createMap()
                    m.putString("sessionId", sessionId)
                    m.putInt("exit_code", code)
                    m.putInt("duration_ms", dur)
                    m.putInt("line_count", session.lineCount.get())
                    emit(EVT_EXIT, m)
                } catch (e: Exception) {
                    val m = Arguments.createMap()
                    m.putString("sessionId", sessionId)
                    m.putString("message", e.message ?: "waitFor failed")
                    emit(EVT_ERROR, m)
                } finally {
                    sessions.remove(sessionId)
                }
            }, "rootshell-wait-$sessionId").start()

            promise.resolve(sessionId)
        } catch (e: Exception) {
            sessions.remove(sessionId)
            Log.e(TAG, "executeStream failed: $command", e)
            promise.reject("ROOT_STREAM_ERR", e.message ?: "unknown", e)
        }
    }

    /**
     * Read a raw byte stream and relay it verbatim to JS in batched base64
     * chunks. Preserves every byte — `\r`, `\n`, ESC sequences — so xterm.js
     * renders true PTY output (prompt redraws, colors, TUI apps) instead of
     * the mangled line-reconstructed text the old readLine() path produced.
     *
     * On stdout, before the `__WE_PID__<pid>\n` marker line is consumed, we
     * buffer bytes into `session.preamble` and strip that line so it never
     * reaches the terminal. Everything after the marker's newline is real
     * output. The marker may arrive split across reads — the preamble
     * accumulates until a newline shows up.
     */
    private fun readStreamRaw(session: Session, stream: InputStream, label: String) {
        val target = if (label == "stdout") session.stdoutBytes else session.stderrBytes
        val buf = ByteArray(4096)
        try {
            while (true) {
                val n = stream.read(buf)
                if (n < 0) break
                if (n == 0) continue

                if (label == "stdout" && !session.pidCaptured) {
                    session.preamble.write(buf, 0, n)
                    val pre = session.preamble.toByteArray()
                    var nl = -1
                    for (i in pre.indices) { if (pre[i] == '\n'.code.toByte()) { nl = i; break } }
                    if (nl < 0) continue  // marker line not complete yet
                    val lineStr = String(pre, 0, nl, Charsets.UTF_8)
                    val markerIdx = lineStr.indexOf("__WE_PID__")
                    if (markerIdx >= 0) {
                        session.pid = lineStr.substring(markerIdx + "__WE_PID__".length).trim().toIntOrNull()
                        val m = Arguments.createMap()
                        m.putString("sessionId", session.id)
                        m.putInt("pid", session.pid ?: -1)
                        emit(EVT_PID, m)
                        // Forward anything AFTER the marker's newline as output.
                        val remStart = nl + 1
                        val remLen = pre.size - remStart
                        if (remLen > 0) appendChunk(session, target, label, pre, remStart, remLen)
                    } else {
                        // No marker — unexpected, but forward the whole preamble
                        // verbatim so nothing is silently dropped.
                        appendChunk(session, target, label, pre, 0, pre.size)
                    }
                    session.pidCaptured = true
                    session.preamble.reset()
                    continue
                }

                appendChunk(session, target, label, buf, 0, n)
            }
        } catch (e: Exception) {
            // stream closed — normal on process exit
            Log.d(TAG, "reader($label) for ${session.id} closed: ${e.message}")
        }
    }

    /**
     * Append bytes to a session's raw batch buffer, eager-flushing that
     * stream alone if it crosses the byte high-watermark (bounds peak memory
     * on dmesg-style bursts). The scheduled 80ms flusher drains the rest.
     */
    private fun appendChunk(
        session: Session, target: ByteArrayOutputStream, label: String,
        data: ByteArray, off: Int, len: Int,
    ) {
        var eagerFlush = false
        synchronized(target) {
            target.write(data, off, len)
            if (target.size() >= FLUSH_HIGH_WATERMARK_BYTES) eagerFlush = true
        }
        if (eagerFlush) {
            val drained: ByteArray = synchronized(target) {
                val copy = target.toByteArray()
                target.reset()
                copy
            }
            if (drained.isNotEmpty()) emitChunk(session, label, drained)
        }
    }

    @ReactMethod
    fun killSession(sessionId: String, graceful: Boolean, promise: Promise) {
        val s = sessions[sessionId]
        if (s == null) {
            promise.resolve(false)
            return
        }
        // Resolve the promise IMMEDIATELY so the JS-side `await killStream()` doesn't
        // block on the kill subprocess. Then do the actual kill work on a background
        // thread, where waitFor() is allowed to block freely.
        //
        // Why this matters: `Runtime.exec("su -c kill ...").waitFor()` blocks the
        // caller until the subprocess returns. RN dispatches @ReactMethod calls on
        // its bridge thread; blocking there freezes the entire JS↔native pipe.
        // Magisk/SuperSU permission prompts can take seconds → ANR → app crash
        // (which is exactly what happened on the first airodump Stop tap; subsequent
        // taps worked because Magisk had cached the permission).
        promise.resolve(true)
        Thread({
            try {
                val pid = s.pid
                if (graceful && pid != null) {
                    // SIGINT — pentest tools (airodump-ng, tcpdump, wifite, hcxdumptool)
                    // catch this and flush their capture files cleanly before exit.
                    runCatching {
                        Runtime.getRuntime().exec(arrayOf("su", "-c", "kill -INT $pid")).waitFor()
                    }
                    // Escalate after 2s grace if process is still alive
                    try { Thread.sleep(2000) } catch (_: InterruptedException) { }
                    if (sessions.containsKey(sessionId) && !s.ended) {
                        Log.w(TAG, "session $sessionId did not exit on SIGINT — escalating to SIGKILL")
                        runCatching {
                            Runtime.getRuntime().exec(arrayOf("su", "-c", "kill -KILL $pid")).waitFor()
                        }
                        runCatching { s.proc.destroy() }
                    }
                } else {
                    if (pid != null) {
                        runCatching {
                            Runtime.getRuntime().exec(arrayOf("su", "-c", "kill -KILL $pid")).waitFor()
                        }
                    }
                    runCatching { s.proc.destroy() }
                }
            } catch (e: Exception) {
                Log.e(TAG, "killSession background work failed for $sessionId", e)
            }
        }, "rootshell-kill-$sessionId").start()
    }

    @ReactMethod
    fun listSessions(promise: Promise) {
        val arr = Arguments.createArray()
        for (s in sessions.values) {
            val m = Arguments.createMap()
            m.putString("sessionId", s.id)
            m.putString("command", s.command)
            m.putInt("pid", s.pid ?: -1)
            m.putDouble("started_at", s.startedAt.toDouble())
            m.putInt("line_count", s.lineCount.get())
            arr.pushMap(m)
        }
        promise.resolve(arr)
    }

    /**
     * Write to the running session's stdin. Used by the AI tab to send chat
     * input to interactive CLI agents (hermes, CAI, …). We write on a worker
     * thread to keep the JS call non-blocking — `proc.outputStream.write()`
     * can block if the pipe is full (rare for chat input, but possible if
     * the agent stops reading because it's mid-response).
     *
     * The data is written verbatim. If [appendNewline] is true a single
     * trailing '\n' is appended — most line-buffered CLIs need this to
     * actually consume the input. Set false for binary or partial-line
     * sends.
     */
    @ReactMethod
    fun writeStdin(sessionId: String, text: String, appendNewline: Boolean, promise: Promise) {
        val session = sessions[sessionId]
        if (session == null) {
            promise.reject("E_NO_SESSION", "Session not found: $sessionId")
            return
        }
        if (session.ended) {
            promise.reject("E_SESSION_ENDED", "Session $sessionId already ended")
            return
        }
        Thread({
            try {
                val payload = if (appendNewline) "$text\n" else text
                val out = session.proc.outputStream
                synchronized(out) {
                    out.write(payload.toByteArray(Charsets.UTF_8))
                    out.flush()
                }
                promise.resolve(payload.length)
            } catch (e: Exception) {
                Log.w(TAG, "writeStdin failed for $sessionId", e)
                promise.reject("E_STDIN_WRITE", e.message ?: "stdin write failed")
            }
        }, "rootshell-stdin-$sessionId").start()
    }

    /**
     * Resize the session's PTY to match xterm's dimensions. The interactive
     * shell runs under util-linux `script`, which owns the pty; we can't
     * ioctl(TIOCSWINSZ) it directly from Kotlin, so we send `stty` down the
     * shell's stdin. The kernel then sets the winsize and delivers SIGWINCH
     * to the foreground process group — so vim/htop/zsh reflow to the real
     * width instead of assuming 80 columns. Sent on a worker thread; may
     * echo a single `stty` line if the user is at a bare prompt (the prompt
     * reprints), so callers should debounce and only send on real changes.
     */
    @ReactMethod
    fun resizeSession(sessionId: String, cols: Int, rows: Int, promise: Promise) {
        val session = sessions[sessionId]
        if (session == null || session.ended) {
            promise.resolve(false)
            return
        }
        val c = if (cols in 1..1000) cols else 80
        val r = if (rows in 1..1000) rows else 24
        Thread({
            try {
                val payload = "stty cols $c rows $r 2>/dev/null\n"
                val out = session.proc.outputStream
                synchronized(out) {
                    out.write(payload.toByteArray(Charsets.UTF_8))
                    out.flush()
                }
                promise.resolve(true)
            } catch (e: Exception) {
                Log.w(TAG, "resizeSession failed for $sessionId", e)
                promise.resolve(false)
            }
        }, "rootshell-resize-$sessionId").start()
    }

    // ------------------------------------------------------------------
    // RN NativeEventEmitter stubs — declared LAST as a defensive measure.
    // ------------------------------------------------------------------
    // RN's bridge introspection used to abort scanning the rest of the class
    // when it hit `removeListeners(count: Int)` (primitive) — RN expects
    // `Integer count` (boxed). Symptom was `typeof RootShell.executeStream`
    // === 'undefined' on the JS side while older methods registered fine.
    // Now: kotlin `Int?` -> java.lang.Integer (boxed); and these stubs come
    // AFTER all real methods, so even if RN still chokes here, nothing real
    // is lost.
    @ReactMethod fun addListener(eventName: String) { /* no-op; RN-reserved */ }
    @ReactMethod fun removeListeners(count: Int?) { /* no-op; RN-reserved */ }

    companion object {
        private const val TAG = "RootShell"
        const val EVT_LINE = "RootShell.line"          // legacy single-line — no longer emitted; kept for back-compat
        const val EVT_LINES = "RootShell.lines"        // legacy batched-lines — no longer emitted; kept for back-compat
        const val EVT_CHUNK = "RootShell.chunk"        // raw base64 byte chunk — the PTY relay path (preferred)
        const val EVT_EXIT = "RootShell.exit"
        const val EVT_ERROR = "RootShell.error"
        const val EVT_PID = "RootShell.pid"
        // Tuning knobs for the output batcher. Drains every 80ms, OR eagerly when a
        // single stream's raw buffer hits 64 KiB (whichever comes first). 80ms is
        // 12 Hz which is below the 16ms-per-frame budget so we never block the JS
        // thread for a visible-stutter duration.
        const val FLUSH_INTERVAL_MS = 80L
        const val FLUSH_HIGH_WATERMARK_BYTES = 64 * 1024
    }
}
