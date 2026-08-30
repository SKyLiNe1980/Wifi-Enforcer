package com.wifienforcer.sshshell

import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.jcraft.jsch.Channel
import com.jcraft.jsch.ChannelExec
import com.jcraft.jsch.ChannelShell
import com.jcraft.jsch.JSch
import com.jcraft.jsch.Session
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap

/**
 * SshShell — an SSH transport that mirrors RootShellModule's streaming contract
 * (executeStream / killSession / writeStdin / resizeSession + chunk/exit/error
 * events) so the app can swap the "kali backend" from the local su→chroot pipe
 * to an SSH session into a Kali VM (Kalidroid / Podroid) or any remote box.
 *
 * ONE persistent JSch Session (the SSH connection) is held open; each app
 * "session" is a channel on it:
 *   • empty command  → ChannelShell  (persistent interactive login shell — the
 *                        Terminal tab). A real PTY, so no `script` hack.
 *   • non-empty cmd  → ChannelExec + PTY (airodump/wifite/AI agents): streams
 *                        and emits exit when the command finishes.
 * Resize uses the real SSH window-change (setPtySize) → proper SIGWINCH.
 *
 * Host-key policy is TOFU: we accept the key and report its fingerprint to JS
 * (SshShell.hostkey) so the JS side can store-on-first-use and warn on change.
 */
class SshShellModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    override fun getName() = "SshShell"

    private var jsch: JSch? = null
    @Volatile private var session: Session? = null

    private data class Chan(val channel: Channel, val stdin: OutputStream)
    private val channels = ConcurrentHashMap<String, Chan>()

    // ── event emit helpers ─────────────────────────────────────────────────
    private fun emit(event: String, params: WritableMap) {
        try {
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(event, params)
        } catch (_: Exception) {}
    }
    private fun emitState(state: String, detail: String) {
        val m = Arguments.createMap()
        m.putString("state", state); m.putString("detail", detail)
        emit("SshShell.state", m)
    }
    private fun emitError(sessionId: String, message: String) {
        val m = Arguments.createMap()
        m.putString("sessionId", sessionId); m.putString("message", message)
        emit("SshShell.error", m)
    }
    private fun emitChunk(sessionId: String, bytes: ByteArray, len: Int) {
        val m = Arguments.createMap()
        m.putString("sessionId", sessionId)
        m.putString("stream", "stdout")
        m.putString("dataB64", Base64.encodeToString(bytes, 0, len, Base64.NO_WRAP))
        m.putInt("bytes", len)
        emit("SshShell.chunk", m)
    }
    private fun emitExit(sessionId: String, code: Int) {
        val m = Arguments.createMap()
        m.putString("sessionId", sessionId)
        m.putInt("exit_code", code); m.putInt("duration_ms", 0); m.putInt("line_count", 0)
        emit("SshShell.exit", m)
    }

    // ── connection ──────────────────────────────────────────────────────────
    @ReactMethod
    fun connect(config: ReadableMap, promise: Promise) {
        try {
            disconnectInternal()
            val host = config.getString("host") ?: ""
            val port = if (config.hasKey("port")) config.getInt("port") else 9922
            val user = config.getString("username") ?: "kali"
            val j = JSch()
            val keyPem = if (config.hasKey("privateKey")) config.getString("privateKey") else null
            if (!keyPem.isNullOrBlank()) {
                val pass = if (config.hasKey("passphrase")) config.getString("passphrase") else null
                j.addIdentity("enforcer", keyPem.toByteArray(), null, pass?.toByteArray())
            }
            val s = j.getSession(user, host, port)
            val pw = if (config.hasKey("password")) config.getString("password") else null
            if (!pw.isNullOrBlank()) s.setPassword(pw)
            // TOFU: accept, then report the fingerprint to JS for compare/warn.
            s.setConfig("StrictHostKeyChecking", "no")
            s.setConfig("PreferredAuthentications", "publickey,password,keyboard-interactive")
            s.serverAliveInterval = 15000
            s.connect(15000)
            jsch = j
            session = s
            try {
                val hk = s.hostKey
                val m = Arguments.createMap()
                m.putString("host", host)
                m.putString("fingerprint", hk?.getFingerPrint(j) ?: "")
                m.putString("keyType", hk?.type ?: "")
                emit("SshShell.hostkey", m)
            } catch (_: Exception) {}
            emitState("connected", "$user@$host:$port")
            promise.resolve(true)
        } catch (e: Exception) {
            emitState("error", e.message ?: "connect failed")
            promise.reject("E_SSH_CONNECT", e.message, e)
        }
    }

    @ReactMethod
    fun isConnected(promise: Promise) { promise.resolve(session?.isConnected == true) }

    @ReactMethod
    fun disconnect(promise: Promise) {
        disconnectInternal(); emitState("down", "disconnected"); promise.resolve(true)
    }

    private fun disconnectInternal() {
        for ((_, c) in channels) { try { c.channel.disconnect() } catch (_: Exception) {} }
        channels.clear()
        try { session?.disconnect() } catch (_: Exception) {}
        session = null
    }

    // ── streaming ─────────────────────────────────────────────────────────
    @ReactMethod
    fun executeStream(sessionId: String, command: String, promise: Promise) {
        val s = session
        if (s == null || !s.isConnected) { promise.reject("E_SSH_NOSESSION", "not connected"); return }
        try {
            val cmd = command.trim()
            val ch: Channel
            if (cmd.isEmpty()) {
                val shell = s.openChannel("shell") as ChannelShell
                shell.setPtyType("xterm-256color", 80, 24, 0, 0)
                shell.setPty(true)
                ch = shell
            } else {
                val exec = s.openChannel("exec") as ChannelExec
                exec.setPtyType("xterm-256color", 80, 24, 0, 0)
                exec.setPty(true)
                exec.setCommand(cmd)
                ch = exec
            }
            val stdin = ch.outputStream
            val stdout = ch.inputStream
            ch.connect(10000)
            channels[sessionId] = Chan(ch, stdin)
            startReader(sessionId, ch, stdout)
            promise.resolve(sessionId)
        } catch (e: Exception) {
            emitError(sessionId, e.message ?: "exec failed")
            promise.reject("E_SSH_EXEC", e.message, e)
        }
    }

    private fun startReader(sessionId: String, channel: Channel, ins: InputStream) {
        Thread({
            val buf = ByteArray(8192)
            try {
                while (true) {
                    val n = ins.read(buf)
                    if (n < 0) break
                    if (n > 0) emitChunk(sessionId, buf, n)
                    if (channel.isClosed && ins.available() == 0) break
                }
            } catch (e: Exception) {
                emitError(sessionId, e.message ?: "read error")
            } finally {
                var code = -1
                try {
                    for (i in 0 until 20) {
                        if (channel.isClosed) { code = channel.exitStatus; break }
                        Thread.sleep(50)
                    }
                } catch (_: Exception) {}
                try { channel.disconnect() } catch (_: Exception) {}
                channels.remove(sessionId)
                emitExit(sessionId, if (code < 0) 0 else code)
            }
        }, "sshshell-$sessionId").start()
    }

    @ReactMethod
    fun writeStdin(sessionId: String, text: String, appendNewline: Boolean, promise: Promise) {
        val c = channels[sessionId]
        if (c == null) { promise.resolve(0); return }
        try {
            val data = (if (appendNewline) "$text\n" else text).toByteArray()
            c.stdin.write(data); c.stdin.flush()
            promise.resolve(data.size)
        } catch (e: Exception) { promise.resolve(0) }
    }

    @ReactMethod
    fun resizeSession(sessionId: String, cols: Int, rows: Int, promise: Promise) {
        val c = channels[sessionId]
        if (c == null) { promise.resolve(false); return }
        try {
            when (val ch = c.channel) {
                is ChannelShell -> ch.setPtySize(cols, rows, 0, 0)
                is ChannelExec -> ch.setPtySize(cols, rows, 0, 0)
                else -> {}
            }
            promise.resolve(true)
        } catch (e: Exception) { promise.resolve(false) }
    }

    @ReactMethod
    fun killSession(sessionId: String, graceful: Boolean, promise: Promise) {
        val c = channels[sessionId]
        if (c == null) { promise.resolve(false); return }
        try {
            if (graceful) { try { c.stdin.write(3); c.stdin.flush() } catch (_: Exception) {} } // ^C
            c.channel.disconnect()
            channels.remove(sessionId)
            promise.resolve(true)
        } catch (e: Exception) { promise.resolve(false) }
    }

    @ReactMethod
    fun listSessions(promise: Promise) {
        val arr = Arguments.createArray()
        for ((id, _) in channels) {
            val m = Arguments.createMap()
            m.putString("sessionId", id); m.putInt("pid", -1)
            arr.pushMap(m)
        }
        promise.resolve(arr)
    }

    @ReactMethod fun addListener(eventName: String) { /* RN emitter contract */ }
    @ReactMethod fun removeListeners(count: Int?) { /* RN emitter contract */ }
}
