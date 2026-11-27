import WifiLock from '../../modules/wifi-lock';

/** Low-latency Wi-Fi while the camera is shown. Never throws; returns whether the lock is held. */
export function holdWifi(): boolean {
  try {
    return WifiLock?.acquire() ?? false;
  } catch {
    return false;
  }
}

export function releaseWifiLock(): void {
  try {
    WifiLock?.release();
  } catch {
    // ignore
  }
}
