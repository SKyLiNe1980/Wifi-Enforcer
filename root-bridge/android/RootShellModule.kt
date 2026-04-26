package com.wifienforcer.rootshell

import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Arguments
import java.io.BufferedReader
import java.io.DataOutputStream
import java.io.InputStreamReader

/**
 * Native bridge that pipes shell commands through `su -c` on a rooted Android device.
 * Exposed to JS as: NativeModules.RootShell
 *
 * Methods:
 *   isRoot(): Promise<boolean>          // checks if `su` exists & we get an interactive shell
 *   exec(cmd: String): Promise<{        // runs ONE command via `su`
 *       command, stdout, stderr, exit_code, duration_ms
 *   }>
 *   execBatch(cmds: ReadableArray): Promise<Array<...>>  // runs many in a single su session
 *
 * SAFETY: This module assumes the device is rooted (Magisk / SuperSU). It does NOT escalate
 * privileges by itself — it only opens a shell that the OS root daemon permits.
 */
class RootShellModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "RootShell"

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
            // Wrap each command with markers so we can split outputs reliably
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

    companion object { private const val TAG = "RootShell" }
}
