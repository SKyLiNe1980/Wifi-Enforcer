package com.wifienforcer.rootshell

import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.BufferedReader
import java.io.DataOutputStream
import java.io.InputStream
import java.io.InputStreamReader
import java.util.concurrent.ConcurrentHashMap
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
    )

    private val sessions = ConcurrentHashMap<String, Session>()

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

            // Line-reader threads
            Thread({ readStreamLines(session, proc.inputStream, "stdout") },
                "rootshell-stdout-$sessionId").start()
            Thread({ readStreamLines(session, proc.errorStream, "stderr") },
                "rootshell-stderr-$sessionId").start()

            // Waiter
            Thread({
                try {
                    val code = proc.waitFor()
                    val dur = (System.currentTimeMillis() - session.startedAt).toInt()
                    session.ended = true
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

    private fun readStreamLines(session: Session, stream: InputStream, label: String) {
        try {
            val reader = BufferedReader(InputStreamReader(stream))
            var line = reader.readLine()
            while (line != null) {
                // Intercept the PID marker on stdout
                if (label == "stdout" && session.pid == null && line.startsWith("__WE_PID__")) {
                    session.pid = line.removePrefix("__WE_PID__").trim().toIntOrNull()
                    val m = Arguments.createMap()
                    m.putString("sessionId", session.id)
                    m.putInt("pid", session.pid ?: -1)
                    emit(EVT_PID, m)
                } else {
                    val n = session.lineCount.incrementAndGet()
                    val m = Arguments.createMap()
                    m.putString("sessionId", session.id)
                    m.putString("stream", label)
                    m.putString("line", line)
                    m.putInt("lineNo", n)
                    emit(EVT_LINE, m)
                }
                line = reader.readLine()
            }
        } catch (e: Exception) {
            // stream closed — normal on process exit
            Log.d(TAG, "reader($label) for ${session.id} closed: ${e.message}")
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
        const val EVT_LINE = "RootShell.line"
        const val EVT_EXIT = "RootShell.exit"
        const val EVT_ERROR = "RootShell.error"
        const val EVT_PID = "RootShell.pid"
    }
}
