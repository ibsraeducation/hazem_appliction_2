import type { PicSize } from './viewerHtml';

// Result posted by the viewer's speed test (see TEST_JS in viewerHtml.ts).
export type Measure = {
  ok: boolean;
  fps: number;
  w?: number;
  h?: number;
  recv?: number; // frames received from the camera
  drawn?: number; // frames shown on screen
  kb?: number | null; // average picture size
  kbps?: number | null; // Wi-Fi speed actually used
  gap?: number; // longest pause between two pictures (ms)
  dec?: number | null; // phone time to decode one picture (ms)
  err?: string;
  method?: string;
};
export type VideoRow = Measure & { size: PicSize; code?: number; sizeOk?: boolean };
export type TestResult = {
  ping: { avg: number; worst: number; miss: number } | null;
  video: VideoRow[];
  photo: Measure | null;
  method: string;
};
export type Level = 'good' | 'warn' | 'bad';
export type Finding = { level: Level; text: string };

export const SIZE_NAME: Record<PicSize, string> = { small: 'Small', medium: 'Medium', large: 'Large' };

export const fpsLevel = (fps: number): Level => (fps >= 20 ? 'good' : fps >= 10 ? 'warn' : 'bad');

/** Best picture size = the one with the most fps (within 1 fps: the smaller, smoother one). */
export function bestSize(r: TestResult): VideoRow | null {
  const ok = r.video.filter((v) => v.ok);
  if (!ok.length) return null;
  return ok.reduce((a, b) => (b.fps > a.fps + 1 ? b : a));
}

/** Turns the measured numbers into a short "what to fix" list, in plain words. */
export function findings(r: TestResult): Finding[] {
  const out: Finding[] = [];
  const ok = r.video.filter((v) => v.ok);
  const best = bestSize(r);

  if (r.ping && r.ping.miss >= 3) {
    out.push({ level: 'bad', text: 'The camera barely answers. Move the phone closer to the camera and restart the camera.' });
  } else if (r.ping && r.ping.avg > 300) {
    out.push({ level: 'warn', text: `The camera answers slowly (${r.ping.avg} ms). The Wi-Fi signal is weak or busy.` });
  }

  if (!ok.length) {
    if (r.photo?.ok) {
      out.push({ level: 'bad', text: `Video doesn't work with this camera, only photo mode (${r.photo.fps} pictures per second). Restart the camera and test again.` });
    } else {
      out.push({ level: 'bad', text: 'The camera sent no picture at all. Unplug the camera for 5 seconds, plug it back in, and test again.' });
    }
    return out;
  }

  const widths = new Set(ok.map((v) => v.w));
  if (ok.length >= 2 && widths.size === 1) {
    out.push({
      level: 'warn',
      text: `Your camera doesn't accept size changes (always ${ok[0].w}x${ok[0].h}). The fps is limited by the camera itself.`,
    });
  }

  // little data per second only matters when it also keeps the fps low
  if (ok.some((v) => (v.kbps != null && v.kbps < 300 && v.fps < 20) || (v.gap ?? 0) > 1000)) {
    out.push({
      level: 'warn',
      text: 'Weak Wi-Fi: pictures arrive slowly or with pauses. Keep the phone close to the camera, away from metal and other Wi-Fi routers.',
    });
  }

  if (ok.some((v) => (v.dec ?? 0) > 40 || ((v.recv ?? 0) > 10 && (v.drawn ?? 0) < (v.recv ?? 0) * 0.7))) {
    out.push({ level: 'warn', text: 'This phone is slow at showing the video. Use the Small picture size.' });
  }

  if (best) {
    const name = SIZE_NAME[best.size];
    if (best.fps >= 20) out.push({ level: 'good', text: `Good: ${name} gives ${best.fps} fps.` });
    else if (best.fps >= 10) out.push({ level: 'warn', text: `Best is ${best.fps} fps (${name}). Usable, but not smooth.` });
    else out.push({ level: 'bad', text: `Low: the best is only ${best.fps} fps (${name}).` });
  }
  return out;
}

/** Plain-text report for sharing. */
export function reportText(r: TestResult): string {
  const L: string[] = ['AiPi Cam speed test'];
  if (r.ping) L.push(`Connection: ${r.ping.avg} ms average, ${r.ping.worst} ms worst, ${r.ping.miss}/5 missed`);
  for (const v of r.video) {
    L.push(
      v.ok
        ? `${SIZE_NAME[v.size]}: ${v.fps} fps, ${v.w}x${v.h}, ${v.kb ?? '-'} kB/picture, ${v.kbps ?? '-'} kB/s, ` +
            `longest pause ${v.gap} ms, decode ${v.dec ?? '-'} ms, shown ${v.drawn}/${v.recv}, code ${v.code} ${v.sizeOk ? 'ok' : 'ignored'}`
        : `${SIZE_NAME[v.size]}: failed (${v.err})`,
    );
  }
  if (r.photo) L.push(r.photo.ok ? `Photo mode: ${r.photo.fps} fps, ${r.photo.w}x${r.photo.h}` : `Photo mode: failed (${r.photo.err})`);
  L.push(`Method: ${r.method || '-'}`, '', 'What to fix:');
  for (const f of findings(r)) L.push(`- [${f.level}] ${f.text}`);
  return L.join('\n');
}
