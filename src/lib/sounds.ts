import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';

// The three recorded warnings. Played from the app, at the phone's media volume.
export type Clip = 'left' | 'right' | 'front';

const FILES: Record<Clip, number> = {
  left: require('../../assets/sounds/left.ogg'),
  right: require('../../assets/sounds/right.ogg'),
  front: require('../../assets/sounds/front.ogg'),
};

const MAX_MS = 6000; // the clips are 1-3 s: never wait longer than this

const players: Partial<Record<Clip, AudioPlayer>> = {};
let ready: Promise<void> | null = null;

function init(): Promise<void> {
  if (!ready) {
    ready = setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'mixWithOthers' }).catch(() => {});
  }
  return ready;
}

/** Loads the clips ahead of time so the first warning plays without delay. */
export function preloadClips(): void {
  init()
    .then(() => {
      (Object.keys(FILES) as Clip[]).forEach((k) => {
        if (!players[k]) players[k] = createAudioPlayer(FILES[k]);
      });
    })
    .catch(() => {});
}

export function stopClips(): void {
  (Object.keys(players) as Clip[]).forEach((k) => {
    try {
      players[k]?.pause();
    } catch {
      // ignore
    }
  });
}

/** Plays one clip. Resolves true when it finished, false if it could not play (caller falls back to speech). */
export async function playClip(k: Clip): Promise<boolean> {
  try {
    await init();
    const p = (players[k] ??= createAudioPlayer(FILES[k]));
    stopClips();
    return await new Promise<boolean>((resolve) => {
      let done = false;
      const end = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sub.remove();
        resolve(ok);
      };
      const timer = setTimeout(() => end(false), MAX_MS);
      const sub = p.addListener('playbackStatusUpdate', (st) => {
        if (st.didJustFinish) end(true);
      });
      p.volume = 1;
      p.seekTo(0)
        .catch(() => {})
        .then(() => p.play());
    });
  } catch {
    return false;
  }
}
