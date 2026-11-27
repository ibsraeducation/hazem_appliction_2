import { PermissionsAndroid, Platform } from 'react-native';
import WifiManager from 'react-native-wifi-reborn';

// The stock firmware's hotspot name varies between builds; accept all of them.
export const CAMERA_SSIDS = ['ai_pi_cam', 'aipi_cam_d200', 'AIPI_CAM_D200'];

// Android's own "join this Wi-Fi" pop-up ("Searching for devices...") is never used:
// it can't find this camera and only fails. The app only checks where the phone is
// connected and talks to the camera directly; if the camera can't be reached, the app
// shows a clear screen that sends the user to the Wi-Fi settings.

const clean = (s: unknown) => String(s ?? '').replace(/^"|"$/g, '').trim();
const isCamera = (ssid: string) => CAMERA_SSIDS.some((s) => s.toLowerCase() === ssid.toLowerCase());

/** Name of the Wi-Fi the phone is on, or null when it can't be read (no permission, Wi-Fi off, Expo Go). */
export async function currentSsid(): Promise<string | null> {
  if (Platform.OS !== 'android' || !WifiManager || typeof WifiManager.getCurrentWifiSSID !== 'function') return null;
  try {
    const perm = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
    if (!perm) await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
    const ssid = clean(await WifiManager.getCurrentWifiSSID());
    return !ssid || ssid.startsWith('<unknown') ? null : ssid;
  } catch {
    return null;
  }
}

/** Keeps this app's traffic on Wi-Fi even though the camera has no internet (no pop-up involved). */
async function useWifiForApp(): Promise<void> {
  try {
    if (WifiManager && typeof WifiManager.forceWifiUsageWithOptions === 'function') {
      await WifiManager.forceWifiUsageWithOptions(true, { noInternet: true });
    }
  } catch {
    // optional: the camera is still reachable if the phone is on its Wi-Fi
  }
}

/**
 * Prepares the connection. Never opens an Android join dialog and never fails on its own:
 * whether the camera really answers is decided by the viewer's first request.
 * Returns the Wi-Fi name if known.
 */
export async function connectToCamera(onStep: (msg: string) => void): Promise<string> {
  onStep('Checking Wi-Fi...');
  const ssid = await currentSsid();
  if (ssid === null || isCamera(ssid)) await useWifiForApp();
  return ssid ?? '';
}

/**
 * Watchdog check while watching: false only when the phone is clearly on another Wi-Fi
 * (the camera can't be reached then). Unknown name => assume fine.
 */
export async function ensureOnCamera(): Promise<boolean> {
  const ssid = await currentSsid();
  return ssid === null || isCamera(ssid);
}

export async function releaseWifi(): Promise<void> {
  try {
    await WifiManager.forceWifiUsageWithOptions(false, { noInternet: false });
  } catch {
    // ignore
  }
}
