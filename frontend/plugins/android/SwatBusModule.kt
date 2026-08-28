package com.wifienforcer.swatbus

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * SwatBus — control surface for the SWAT foreground-connection service that
 * keeps the IRC WebSocket alive while the app is backgrounded.
 *
 *   start(nick, channel)     start FGS + acquire partial wakelock
 *   stop()                   stop FGS + release wakelock
 *   update(status,nick,ch,i) refresh the persistent notification (LED colour)
 *   requestNotifPermission() Android 13+ POST_NOTIFICATIONS
 *   requestBatteryExemption()REQUEST_IGNORE_BATTERY_OPTIMIZATIONS dialog
 *   isIgnoringBattery()      -> boolean
 */
class SwatBusModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    override fun getName() = "SwatBus"

    private fun svc(action: String, extras: (Intent) -> Unit = {}): Intent =
        Intent(ctx, SwatBusService::class.java).setAction(action).also(extras)

    @ReactMethod
    fun start(nick: String, channel: String, promise: Promise) {
        try {
            val i = svc(SwatBusService.ACTION_START) {
                it.putExtra("nick", nick); it.putExtra("channel", channel)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
            else ctx.startService(i)
            promise.resolve(true)
        } catch (e: Exception) { promise.reject("E_SWAT_START", e.message, e) }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        try { ctx.stopService(Intent(ctx, SwatBusService::class.java)); promise.resolve(true) }
        catch (e: Exception) { promise.reject("E_SWAT_STOP", e.message, e) }
    }

    @ReactMethod
    fun update(status: String, nick: String, channel: String, info: String, promise: Promise) {
        try {
            if (SwatBusService.isRunning) {
                val i = svc(SwatBusService.ACTION_UPDATE) {
                    it.putExtra("status", status); it.putExtra("nick", nick)
                    it.putExtra("channel", channel); it.putExtra("info", info)
                }
                ctx.startService(i)
            }
            promise.resolve(true)
        } catch (e: Exception) { promise.reject("E_SWAT_UPDATE", e.message, e) }
    }

    @ReactMethod
    fun requestNotifPermission(promise: Promise) {
        // POST_NOTIFICATIONS is a runtime permission on 13+. We can only open
        // app notification settings from a module (no Activity result here);
        // the FGS still runs without it, just without a visible notification.
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                val i = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx.startActivity(i)
            }
            promise.resolve(true)
        } catch (e: Exception) { promise.reject("E_SWAT_NOTIF", e.message, e) }
    }

    @SuppressLint("BatteryLife")
    @ReactMethod
    fun requestBatteryExemption(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !isIgnoring()) {
                val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:" + ctx.packageName))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx.startActivity(i)
            }
            promise.resolve(true)
        } catch (e: Exception) { promise.reject("E_SWAT_BATT", e.message, e) }
    }

    private fun isIgnoring(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.isIgnoringBatteryOptimizations(ctx.packageName)
    }

    @ReactMethod
    fun isIgnoringBattery(promise: Promise) { promise.resolve(isIgnoring()) }

    /**
     * Fire a one-shot, high-importance HEADS-UP notification for a #SWAT event
     * (@mention / MISSION / HALT). Purely LOCAL — the live WebSocket (kept
     * alive by the FGS) hands us the line; no FCM / remote push involved. Uses
     * a separate high-importance channel so it pops over the low-importance
     * persistent connection notification.
     */
    @ReactMethod
    fun notify(title: String, body: String, color: String, promise: Promise) {
        try {
            val chId = "swat_alerts"
            val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                mgr.getNotificationChannel(chId) == null) {
                val ch = NotificationChannel(chId, "SWAT alerts", NotificationManager.IMPORTANCE_HIGH)
                ch.description = "@mentions and mission events from #SWAT."
                ch.enableVibration(true)
                mgr.createNotificationChannel(ch)
            }
            val open = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
            val openPI = if (open != null) PendingIntent.getActivity(
                ctx, 3, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            ) else null
            val accent = try { Color.parseColor(color) } catch (e: Exception) { 0xFF00FF66.toInt() }
            val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                Notification.Builder(ctx, chId) else @Suppress("DEPRECATION") Notification.Builder(ctx)
            b.setContentTitle(title)
                .setContentText(body)
                .setStyle(Notification.BigTextStyle().bigText(body))
                .setSmallIcon(ctx.applicationInfo.icon)
                .setColor(accent)
                .setColorized(true)
                .setAutoCancel(true)
            // Pre-O heads-up relies on priority; O+ uses the channel importance.
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                @Suppress("DEPRECATION")
                b.setPriority(Notification.PRIORITY_HIGH)
            }
            if (openPI != null) b.setContentIntent(openPI)
            val id = (System.currentTimeMillis() % 100000L).toInt()
            mgr.notify(id, b.build())
            promise.resolve(true)
        } catch (e: Exception) { promise.reject("E_SWAT_NOTIFY", e.message, e) }
    }

    @ReactMethod fun addListener(eventName: String) { /* no-op */ }
    @ReactMethod fun removeListeners(count: Int?) { /* no-op */ }
}
