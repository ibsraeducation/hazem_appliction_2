export type ErrorCode = 'unreachable' | 'novideo' | 'lost' | 'permission' | 'wifi-join' | 'expo-go' | 'timeout' | 'other';

/** What the user can press on the error screen. */
export type Action = 'retry' | 'wifi' | 'appSettings' | 'cameraPage';

export type Help = {
  title: string;
  reason: string;
  steps: string[];
  primary: { label: string; action: Action };
  secondary?: { label: string; action: Action };
  /** retry by itself after this many seconds (only where that can help) */
  autoRetry?: number;
};

const WIFI = 'AIPI_CAM_D200 (or ai_pi_cam)';

/** Turns a raw error (code from the viewer, or exception text from Wi-Fi joining) into an error code. */
export function codeFor(raw: string): ErrorCode {
  const m = raw.toLowerCase();
  if (m === 'unreachable' || m === 'novideo' || m === 'lost' || m === 'timeout') return m;
  if (m.includes('native_missing') || m.includes('of null')) return 'expo-go';
  if (m.includes('permission')) return 'permission';
  if (m.includes('could not join') || m.includes('not found') || m.includes('android only')) return 'wifi-join';
  return 'other';
}

/** Plain-language explanation and the exact actions for each error. */
export function helpFor(code: ErrorCode): Help {
  switch (code) {
    case 'unreachable':
      return {
        title: 'Phone is not connected to the camera',
        reason: 'The camera did not answer. The phone is probably on another Wi-Fi or using mobile data.',
        steps: [
          `Tap "Open Wi-Fi settings" and connect to ${WIFI}.`,
          'If Android asks "No internet - stay connected?", choose Stay connected.',
          'Turn mobile data OFF.',
          'Come back and tap "Try again".',
        ],
        primary: { label: 'Open Wi-Fi settings', action: 'wifi' },
        secondary: { label: 'Try again', action: 'retry' },
      };
    case 'novideo':
      return {
        title: 'Camera found, but no picture',
        reason: 'The phone reached the camera, but the camera is not sending pictures right now.',
        steps: [
          'Close any other app or browser tab that shows the camera (it allows only one viewer).',
          'Unplug the camera, wait 5 seconds, plug it back in.',
          'Wait 20 seconds for it to start, then tap "Try again".',
        ],
        primary: { label: 'Try again', action: 'retry' },
        secondary: { label: 'Open camera page', action: 'cameraPage' },
      };
    case 'lost':
      return {
        title: 'Picture stopped',
        reason: 'The camera stopped sending pictures for 30 seconds.',
        steps: [
          'Check the camera still has power (light on).',
          'Keep the phone within a few metres of the camera.',
          'The app will try again by itself, or tap "Try again" now.',
        ],
        primary: { label: 'Try again', action: 'retry' },
        secondary: { label: 'Open Wi-Fi settings', action: 'wifi' },
        autoRetry: 5,
      };
    case 'timeout':
      return {
        title: 'Camera is taking too long',
        reason: 'No picture arrived within 45 seconds.',
        steps: [
          'Unplug the camera, wait 5 seconds, plug it back in.',
          'Wait 20 seconds, then tap "Try again".',
        ],
        primary: { label: 'Try again', action: 'retry' },
        secondary: { label: 'Open Wi-Fi settings', action: 'wifi' },
      };
    case 'permission':
      return {
        title: 'Permission needed',
        reason: 'Android only lets apps join a Wi-Fi network when Location permission is allowed.',
        steps: [
          'Tap "Allow" and choose "While using the app".',
          'If no question appears: tap "Open app settings" → Permissions → Location → Allow.',
        ],
        primary: { label: 'Allow', action: 'retry' },
        secondary: { label: 'Open app settings', action: 'appSettings' },
      };
    case 'wifi-join':
      return {
        title: "Couldn't join the camera Wi-Fi",
        reason: 'The camera Wi-Fi was not found or did not accept the connection.',
        steps: [
          'Check the camera is plugged in and its light is on. Wait 20 seconds after plugging in.',
          'Move the phone close to the camera.',
          `Or connect by hand: tap "Open Wi-Fi settings" and join ${WIFI}.`,
          'Then tap "Try again".',
        ],
        primary: { label: 'Try again', action: 'retry' },
        secondary: { label: 'Open Wi-Fi settings', action: 'wifi' },
      };
    case 'expo-go':
      return {
        title: 'Join the camera Wi-Fi first',
        reason: 'This test version cannot switch Wi-Fi by itself.',
        steps: [`Tap "Open Wi-Fi settings" and connect to ${WIFI}.`, 'Turn mobile data OFF.', 'Come back and tap "Try again".'],
        primary: { label: 'Open Wi-Fi settings', action: 'wifi' },
        secondary: { label: 'Try again', action: 'retry' },
      };
    default:
      return {
        title: 'Something went wrong',
        reason: 'The camera connection failed for an unexpected reason.',
        steps: ['Unplug the camera, wait 5 seconds, plug it back in.', 'Wait 20 seconds, then tap "Try again".'],
        primary: { label: 'Try again', action: 'retry' },
        secondary: { label: 'Open Wi-Fi settings', action: 'wifi' },
      };
  }
}
