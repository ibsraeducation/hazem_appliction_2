package expo.modules.wifilock

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Keeps the phone's Wi-Fi out of power-save while the camera picture is shown.
// Power-save delays every new connection, and the camera needs one connection per photo.
class WifiLockModule : Module() {
  private var lock: WifiManager.WifiLock? = null

  override fun definition() = ModuleDefinition {
    Name("WifiLock")

    // Returns true when the lock is held.
    Function("acquire") {
      if (lock?.isHeld == true) return@Function true
      val ctx = appContext.reactContext ?: return@Function false
      val wifi = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        ?: return@Function false
      @Suppress("DEPRECATION")
      val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) WifiManager.WIFI_MODE_FULL_LOW_LATENCY
        else WifiManager.WIFI_MODE_FULL_HIGH_PERF
      val l = wifi.createWifiLock(mode, "aipicam:camera")
      l.setReferenceCounted(false)
      l.acquire()
      lock = l
      return@Function l.isHeld
    }

    Function("release") {
      lock?.let { if (it.isHeld) it.release() }
      lock = null
    }

    OnDestroy {
      lock?.let { if (it.isHeld) it.release() }
      lock = null
    }
  }
}
