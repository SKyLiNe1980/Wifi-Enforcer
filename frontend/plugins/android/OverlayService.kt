package com.wifienforcer.overlay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.abs

/**
 * OverlayService — draws the rugged floating command bubble via WindowManager
 * (TYPE_APPLICATION_OVERLAY) so it stays on top of OTHER apps, and executes
 * button taps:
 *   • kind == "mcp_tool"  → fires the MCP tools/call directly over HTTP,
 *                           right here in the service (no app focus needed).
 *   • kind == "app"/"navigate" → stashes the slot id + launches the app so the
 *                           RN side can run it with full DB/root context.
 *
 * Config is read from SharedPreferences (written by the RN OverlayControl
 * bridge). Runs as a foreground service so Android keeps the window alive
 * while the operator is in other apps.
 */
class OverlayService : Service() {

    private lateinit var wm: WindowManager
    private var root: LinearLayout? = null
    private var buttons: LinearLayout? = null
    private var expanded = false
    private lateinit var params: WindowManager.LayoutParams
    private val ui = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        isRunning = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // startForeground FIRST (must happen within ~5s or the OS ANR-kills us).
        promoteForeground()
        try {
            if (root == null) addOverlay()
            else rebuildButtons()
        } catch (e: Exception) {
            Log.e(TAG, "overlay build failed", e)
        }
        return START_STICKY
    }

    // ---- foreground notification --------------------------------------------
    private fun promoteForeground() {
        val chId = "enforcer_overlay"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(NotificationManager::class.java)
            if (mgr.getNotificationChannel(chId) == null) {
                val ch = NotificationChannel(chId, "Command Overlay", NotificationManager.IMPORTANCE_MIN)
                ch.description = "Keeps the floating command toolbar active."
                ch.setShowBadge(false)
                mgr.createNotificationChannel(ch)
            }
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, chId) else @Suppress("DEPRECATION") Notification.Builder(this)
        val notif = builder
            .setContentTitle("Enforcer overlay active")
            .setContentText("Floating command toolbar is armed")
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, notif, 0)
            } else {
                startForeground(NOTIF_ID, notif)
            }
        } catch (e: Exception) {
            Log.e(TAG, "startForeground failed", e)
        }
    }

    // ---- overlay window ------------------------------------------------------
    private fun addOverlay() {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE

        params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        )
        params.gravity = Gravity.TOP or Gravity.START
        val prefs = getSharedPreferences(OverlayModule.PREFS, Context.MODE_PRIVATE)
        params.x = prefs.getInt(KEY_X, dp(280))
        params.y = prefs.getInt(KEY_Y, dp(320))

        root = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            visibility = View.GONE
            background = panelBg(0xFF0E1820.toInt())
            setPadding(dp(4), dp(4), dp(4), dp(4))
        }
        root!!.addView(buttons)
        root!!.addView(makeBubble())

        rebuildButtons()
        wm.addView(root, params)
    }

    private fun makeBubble(): View {
        val size = dp(52)
        val bubble = TextView(this).apply {
            text = "\u25C9" // ◉ radar-ish mark
            textSize = 22f
            setTextColor(0xFF00FF66.toInt())
            gravity = Gravity.CENTER
            val bg = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(0xFF1C2833.toInt())
                setStroke(dp(2), 0xFF163041.toInt())
            }
            background = bg
            layoutParams = LinearLayout.LayoutParams(size, size).apply { leftMargin = dp(2) }
        }
        attachDrag(bubble)
        return bubble
    }

    /** Drag to move; short tap toggles the button row. */
    private fun attachDrag(handle: View) {
        var downX = 0f; var downY = 0f
        var startX = 0; var startY = 0
        var moved = false
        val slop = dp(8)
        handle.setOnTouchListener { _, e ->
            when (e.action) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY
                    startX = params.x; startY = params.y
                    moved = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (e.rawX - downX).toInt()
                    val dy = (e.rawY - downY).toInt()
                    if (abs(dx) > slop || abs(dy) > slop) moved = true
                    params.x = startX + dx
                    params.y = startY + dy
                    try { wm.updateViewLayout(root, params) } catch (_: Exception) {}
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (!moved) toggleExpanded()
                    else { savePosition(); clampToScreen() }
                    true
                }
                else -> false
            }
        }
    }

    private fun toggleExpanded() {
        expanded = !expanded
        buttons?.visibility = if (expanded) View.VISIBLE else View.GONE
        // After the width changes, re-clamp so the (now wider) bar can't hang
        // off the screen edge and leave the drag-handle bubble unreachable.
        root?.post { clampToScreen() }
    }

    /** Keep the whole overlay within screen bounds (post-layout). */
    private fun clampToScreen() {
        val r = root ?: return
        val w = r.width
        val h = r.height
        if (w == 0 || h == 0) return
        val dm = resources.displayMetrics
        var x = params.x
        var y = params.y
        if (x + w > dm.widthPixels) x = dm.widthPixels - w
        if (x < 0) x = 0
        if (y + h > dm.heightPixels) y = dm.heightPixels - h
        if (y < 0) y = 0
        if (x != params.x || y != params.y) {
            params.x = x
            params.y = y
            try { wm.updateViewLayout(r, params) } catch (_: Exception) {}
            savePosition()
        }
    }

    private fun savePosition() {
        getSharedPreferences(OverlayModule.PREFS, Context.MODE_PRIVATE)
            .edit().putInt(KEY_X, params.x).putInt(KEY_Y, params.y).apply()
    }

    // ---- buttons from config -------------------------------------------------
    private fun rebuildButtons() {
        val b = buttons ?: return
        b.removeAllViews()
        val cfg = readConfig()
        val slots = cfg?.optJSONArray("slots")
        if (slots == null || slots.length() == 0) {
            b.addView(makeButton("NO SLOTS", 0xFF163041.toInt(), null))
            return
        }
        for (i in 0 until slots.length()) {
            val s = slots.optJSONObject(i) ?: continue
            val label = s.optString("label", "?")
            val led = parseColor(s.optString("led", "#163041"), 0xFF163041.toInt())
            val cell = makeButton(label, led) { fire(s, it) }
            b.addView(cell)
        }
        // widths just changed — keep everything on-screen if currently expanded.
        root?.post { clampToScreen() }
    }

    private fun makeButton(label: String, led: Int, onTap: ((TextView) -> Unit)?): View {
        val cell = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            background = panelBg(0xFF0A1116.toInt())
            setPadding(dp(8), dp(8), dp(8), dp(6))
            layoutParams = LinearLayout.LayoutParams(dp(58), dp(52)).apply { leftMargin = dp(4); rightMargin = dp(4) }
        }
        val txt = TextView(this).apply {
            text = label
            textSize = 10f
            setTextColor(0xFFCFEADB.toInt())
            gravity = Gravity.CENTER
        }
        val ledBar = View(this).apply {
            setBackgroundColor(led)
            layoutParams = LinearLayout.LayoutParams(dp(30), dp(3)).apply { topMargin = dp(6) }
        }
        cell.addView(txt)
        cell.addView(ledBar)
        if (onTap != null) {
            cell.setOnClickListener { onTap(txt) }
            cell.isClickable = true
        }
        // stash ledBar on the cell so fire() can flash it
        cell.tag = ledBar
        return cell
    }

    private fun fire(slot: JSONObject, label: TextView) {
        val kind = slot.optString("kind", "app")
        val cell = label.parent as? View
        val ledBar = cell?.tag as? View
        flash(ledBar, 0xFFFFD400.toInt()) // amber = firing
        if (kind == "mcp_tool") {
            val host = slot.optString("host", "")
            val port = slot.optInt("port", 0)
            val token = slot.optString("token", "")
            val tool = slot.optString("tool", "")
            val args = slot.optJSONObject("args") ?: JSONObject()
            if (host.isEmpty() || port == 0 || tool.isEmpty()) {
                toast("slot not fully configured")
                flash(ledBar, 0xFFFF3860.toInt())
                return
            }
            Thread {
                val (ok, msg) = doMcp(host, port, token, tool, args)
                ui.post {
                    flash(ledBar, if (ok) 0xFF00FF66.toInt() else 0xFFFF3860.toInt())
                    toast(if (ok) "${slot.optString("label")} ✓" else "${slot.optString("label")}: $msg")
                }
            }.start()
        } else {
            // app action / navigate → bring the app forward to run it in RN.
            getSharedPreferences(OverlayModule.PREFS, Context.MODE_PRIVATE)
                .edit().putString(OverlayModule.KEY_PENDING, slot.optString("id")).apply()
            val launch = packageManager.getLaunchIntentForPackage(packageName)
            if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                startActivity(launch)
                flash(ledBar, 0xFF3AD7FF.toInt())
            } else {
                flash(ledBar, 0xFFFF3860.toInt())
            }
        }
    }

    private fun flash(v: View?, color: Int) {
        if (v == null) return
        v.setBackgroundColor(color)
        ui.postDelayed({ v.setBackgroundColor(0xFF163041.toInt()) }, 1300)
    }

    private fun toast(msg: String) {
        try { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show() } catch (_: Exception) {}
    }

    // ---- MCP over HTTP (mirrors src/lib/mcpClient.ts) -------------------------
    private fun doMcp(host: String, port: Int, token: String, tool: String, args: JSONObject): Pair<Boolean, String> {
        val base = "http://$host:$port/mcp"
        try {
            val initReq = JSONObject()
                .put("jsonrpc", "2.0").put("id", 1).put("method", "initialize")
                .put("params", JSONObject()
                    .put("protocolVersion", PROTO)
                    .put("capabilities", JSONObject())
                    .put("clientInfo", JSONObject().put("name", "enforcer-overlay").put("version", "1.0")))
            val init = httpPost(base, initReq.toString(), token, null)
            if (init.status >= 400) return false to "init HTTP ${init.status}"

            val notif = JSONObject().put("jsonrpc", "2.0").put("method", "notifications/initialized")
            try { httpPost(base, notif.toString(), token, init.sid) } catch (_: Exception) {}

            val callReq = JSONObject()
                .put("jsonrpc", "2.0").put("id", 2).put("method", "tools/call")
                .put("params", JSONObject().put("name", tool).put("arguments", args))
            val call = httpPost(base, callReq.toString(), token, init.sid)
            if (call.status >= 400) return false to "call HTTP ${call.status}"

            val msg = parseBody(call.body) ?: return false to "empty response"
            if (msg.has("error")) {
                val em = msg.optJSONObject("error")?.optString("message") ?: "tool error"
                return false to em
            }
            return true to "ok"
        } catch (e: Exception) {
            return false to (e.message ?: "network error")
        }
    }

    private data class HttpResp(val status: Int, val sid: String?, val body: String)

    private fun httpPost(urlStr: String, json: String, token: String?, sid: String?): HttpResp {
        val url = URL(urlStr)
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.connectTimeout = 8000
        conn.readTimeout = 8000
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("Accept", "application/json, text/event-stream")
        if (!token.isNullOrEmpty()) conn.setRequestProperty("Authorization", "Bearer $token")
        if (!sid.isNullOrEmpty()) {
            conn.setRequestProperty("Mcp-Session-Id", sid)
            conn.setRequestProperty("MCP-Protocol-Version", PROTO)
        }
        try {
            val os: OutputStream = conn.outputStream
            os.write(json.toByteArray(Charsets.UTF_8))
            os.flush(); os.close()
            val status = conn.responseCode
            val respSid = conn.getHeaderField("Mcp-Session-Id")
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            val body = stream?.let { BufferedReader(InputStreamReader(it)).use { r -> r.readText() } } ?: ""
            return HttpResp(status, respSid, body)
        } finally {
            conn.disconnect()
        }
    }

    /** FastMCP body: plain JSON or SSE `data:` frames. Returns the JSON-RPC object. */
    private fun parseBody(text: String): JSONObject? {
        val t = text.trim()
        if (t.isEmpty()) return null
        if (t.startsWith("{")) {
            try { return JSONObject(t) } catch (_: Exception) {}
        }
        val dataLines = t.split(Regex("\r?\n"))
            .filter { it.startsWith("data:") }
            .map { it.substring(5).trim() }
        for (i in dataLines.indices.reversed()) {
            try {
                val j = JSONObject(dataLines[i])
                if (j.has("result") || j.has("error")) return j
            } catch (_: Exception) {}
        }
        for (d in dataLines) {
            try { return JSONObject(d) } catch (_: Exception) {}
        }
        return null
    }

    private fun readConfig(): JSONObject? {
        val raw = getSharedPreferences(OverlayModule.PREFS, Context.MODE_PRIVATE)
            .getString(OverlayModule.KEY_CONFIG, null) ?: return null
        return try { JSONObject(raw) } catch (_: Exception) { null }
    }

    // ---- helpers -------------------------------------------------------------
    private fun panelBg(fill: Int): GradientDrawable = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(6).toFloat()
        setStroke(dp(1), 0xFF163041.toInt())
    }

    private fun parseColor(hex: String, fallback: Int): Int =
        try { Color.parseColor(hex) } catch (_: Exception) { fallback }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    override fun onDestroy() {
        super.onDestroy()
        isRunning = false
        try { root?.let { wm.removeView(it) } } catch (_: Exception) {}
        root = null
    }

    companion object {
        @Volatile var isRunning = false
        private const val TAG = "EnforcerOverlay"
        private const val NOTIF_ID = 7731
        private const val PROTO = "2025-06-18"
        private const val KEY_X = "overlay_x"
        private const val KEY_Y = "overlay_y"
    }
}
