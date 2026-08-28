package com.wifienforcer.swatbus

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
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

    @ReactMethod fun addListener(eventName: String) { /* no-op */ }
    @ReactMethod fun removeListeners(count: Int?) { /* no-op */ }
}
