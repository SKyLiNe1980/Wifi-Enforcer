package com.wifienforcer.swatbus

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log

/**
 * SwatBusService — foreground service that keeps the app process alive while
 * connected to the SWAT bus, so the React-Native JS thread (and its IRC
 * WebSocket + ping/pong timers) keeps running in the background. Holds a
 * PARTIAL_WAKE_LOCK and shows a persistent notification whose accent colour is
 * the connection LED (green/yellow/red).
 */
class SwatBusService : Service() {

    private var wake: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        isRunning = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START
        when (action) {
            ACTION_STOP -> { stopSelf(); return START_NOT_STICKY }
            ACTION_UPDATE -> {
                status = intent?.getStringExtra("status") ?: status
                nick = intent?.getStringExtra("nick") ?: nick
                channel = intent?.getStringExtra("channel") ?: channel
                info = intent?.getStringExtra("info") ?: info
            }
            else -> { // ACTION_START
                nick = intent?.getStringExtra("nick") ?: nick
                channel = intent?.getStringExtra("channel") ?: channel
                status = "connecting"
                acquireWake()
            }
        }
        promote()
        return START_STICKY
    }

    private fun acquireWake() {
        if (wake?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "enforcer:swatbus").apply {
            setReferenceCounted(false)
            acquire(12 * 60 * 60 * 1000L) // 12h safety cap
        }
    }

    private fun ledColor(): Int = when (status) {
        "connected" -> 0xFF00FF66.toInt()
        "connecting" -> 0xFFFFD400.toInt()
        else -> 0xFFFF3860.toInt()
    }

    private fun promote() {
        val chId = "swat_connection"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(NotificationManager::class.java)
            if (mgr.getNotificationChannel(chId) == null) {
                val ch = NotificationChannel(chId, "SWAT connection", NotificationManager.IMPORTANCE_LOW)
                ch.description = "Keeps the SWAT bus connection alive in the background."
                ch.setShowBadge(false)
                mgr.createNotificationChannel(ch)
            }
        }
        val stopPI = PendingIntent.getService(
            this, 1, Intent(this, SwatBusService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val open = packageManager.getLaunchIntentForPackage(packageName)
        val openPI = if (open != null) PendingIntent.getActivity(
            this, 2, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ) else null

        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, chId) else @Suppress("DEPRECATION") Notification.Builder(this)
        b.setContentTitle("SWAT · ${status.uppercase()}")
            .setContentText("$nick @ $channel${if (info.isNotEmpty()) "  ·  $info" else ""}")
            .setSmallIcon(applicationInfo.icon)
            .setColor(ledColor())
            .setColorized(true)
            .setOngoing(true)
        if (openPI != null) b.setContentIntent(openPI)
        b.addAction(Notification.Action.Builder(0, "Disconnect", stopPI).build())
        val notif = b.build()

        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, notif, 0)
            } else {
                startForeground(NOTIF_ID, notif)
            }
        } catch (e: Exception) { Log.e(TAG, "startForeground failed", e) }
    }

    override fun onDestroy() {
        super.onDestroy()
        isRunning = false
        try { if (wake?.isHeld == true) wake?.release() } catch (_: Exception) {}
        wake = null
    }

    companion object {
        @Volatile var isRunning = false
        private const val TAG = "SwatBus"
        private const val NOTIF_ID = 7742
        const val ACTION_START = "com.wifienforcer.swatbus.START"
        const val ACTION_STOP = "com.wifienforcer.swatbus.STOP"
        const val ACTION_UPDATE = "com.wifienforcer.swatbus.UPDATE"
        @Volatile private var status = "connecting"
        @Volatile private var nick = ""
        @Volatile private var channel = "#SWAT"
        @Volatile private var info = ""
    }
}
