package com.wifienforcer.overlay

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * OverlayControl — JS bridge for the system-wide floating command overlay.
 *
 * Exposed as: NativeModules.OverlayControl
 *
 *   hasPermission(): Promise<boolean>         Settings.canDrawOverlays()
 *   requestPermission(): Promise<boolean>     opens the "Display over other apps" screen
 *   syncConfig(json): Promise<boolean>        persists slot config for the service to read
 *   show(): Promise<boolean>                  starts the foreground overlay service
 *   hide(): Promise<boolean>                  stops it
 *   isRunning(): Promise<boolean>
 *   consumePendingSlot(): Promise<string?>    slot id an overlay tap wants the app to run
 *
 * The heavy lifting (WindowManager view + MCP HTTP calls) lives in
 * OverlayService — this module is just the control surface.
 */
class OverlayModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "OverlayControl"

    private fun prefs() =
        reactContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @ReactMethod
    fun hasPermission(promise: Promise) {
        promise.resolve(canDraw())
    }

    private fun canDraw(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(reactContext)

    @ReactMethod
    fun requestPermission(promise: Promise) {
        try {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + reactContext.packageName),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("E_OVERLAY_PERM", e.message ?: "cannot open overlay settings", e)
        }
    }

    @ReactMethod
    fun syncConfig(json: String, promise: Promise) {
        try {
            prefs().edit().putString(KEY_CONFIG, json).apply()
            // If the service is already up, nudge it to reload + redraw.
            if (OverlayService.isRunning) {
                val i = Intent(reactContext, OverlayService::class.java).setAction(ACTION_REFRESH)
                reactContext.startService(i)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("E_OVERLAY_SYNC", e.message ?: "sync failed", e)
        }
    }

    @ReactMethod
    fun show(promise: Promise) {
        if (!canDraw()) {
            promise.reject("E_NO_PERMISSION", "overlay permission not granted")
            return
        }
        try {
            val i = Intent(reactContext, OverlayService::class.java).setAction(ACTION_SHOW)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                reactContext.startForegroundService(i)
            } else {
                reactContext.startService(i)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("E_OVERLAY_SHOW", e.message ?: "cannot start overlay", e)
        }
    }

    @ReactMethod
    fun hide(promise: Promise) {
        try {
            reactContext.stopService(Intent(reactContext, OverlayService::class.java))
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("E_OVERLAY_HIDE", e.message ?: "cannot stop overlay", e)
        }
    }

    @ReactMethod
    fun isRunning(promise: Promise) {
        promise.resolve(OverlayService.isRunning)
    }

    @ReactMethod
    fun consumePendingSlot(promise: Promise) {
        val p = prefs()
        val id = p.getString(KEY_PENDING, null)
        if (id != null) p.edit().remove(KEY_PENDING).apply()
        promise.resolve(id)
    }

    // RN NativeEventEmitter reserved stubs (harmless; keep bridge introspection happy).
    @ReactMethod fun addListener(eventName: String) { /* no-op */ }
    @ReactMethod fun removeListeners(count: Int?) { /* no-op */ }

    companion object {
        const val PREFS = "enforcer_overlay"
        const val KEY_CONFIG = "overlay_config"
        const val KEY_PENDING = "pending_slot_id"
        const val ACTION_SHOW = "com.wifienforcer.overlay.SHOW"
        const val ACTION_REFRESH = "com.wifienforcer.overlay.REFRESH"
    }
}
