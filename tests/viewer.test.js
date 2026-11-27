// Viewer + speed test checks, run with a fake browser, fake time and a fake camera.
// Usage: npm test   (or: node tests/viewer.test.js)
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
const ts = require(path.join(root, 'node_modules/typescript'));
const load = (file) => {
  const js = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: 1 } }).outputText;
  const m = { exports: {} };
  new Function('module', 'exports', 'require', js)(m, m.exports, () => ({}));
  return m.exports;
};
const V = load('src/lib/viewerHtml.ts');
const S = load('src/lib/speedTest.ts');
const fail = (s) => { console.error('FAIL: ' + s); process.exit(1); };
const ok = (s) => console.log('OK   ' + s);

// ---------- 1. page script parses (normal and test mode) ----------
const pageFor = (size, code, test) => {
  const h = V.viewerHtml('192.168.169.1', true, null, size, code, test);
  return h.split('<script>')[1].split('</script>')[0];
};
new Function(pageFor('small', null, false));
new Function(pageFor('large', '9', true));
ok('page script parses (viewer and speed test)');

// ---------- 2. frame extractor ----------
const makeExtractor = new Function(V.FRAME_EXTRACTOR_JS + '; return makeExtractor;')();
const jpg = (id, pad = 0) => [0xff, 0xd8, id, id, ...new Array(pad).fill(0x11), 0xff, 0x00, id, 0xff, 0xd9];
const hdr = (s) => Array.from(Buffer.from(s));
const sep = hdr('\r\n--frame\r\nContent-Type: image/jpeg\r\n\r\n');
{
  const stream = [...sep, ...jpg(1), ...sep, ...jpg(2), ...sep, ...jpg(3), ...sep, ...jpg(4)];
  const got = [];
  const push = makeExtractor((f) => got.push(f[2]));
  const cut1 = stream.indexOf(3) + 1, cut2 = stream.lastIndexOf(0xd9);
  push(Uint8Array.from(stream.slice(0, cut1)));
  push(Uint8Array.from(stream.slice(cut1, cut2)));
  push(Uint8Array.from(stream.slice(cut2)));
  if (got.join(',') !== '2,3,4') fail('extractor gave ' + got.join(','));
  ok('extractor keeps only the newest frame per chunk');
}
{
  // every possible split point, incl. inside FF D8 and FF D9: the frame must come out intact
  const one = [...sep, ...jpg(7, 20), ...sep];
  for (let cut = 1; cut < one.length; cut++) {
    let out = null;
    const push = makeExtractor((f) => { out = Array.from(f); });
    push(Uint8Array.from(one.slice(0, cut)));
    push(Uint8Array.from(one.slice(cut)));
    if (!out || out.join(',') !== jpg(7, 20).join(',')) fail('frame broken when split at byte ' + cut);
  }
  ok('markers split across chunks are handled (all split points)');
}
{
  // 100 frames of 30 kB in 1.4 kB chunks: all found, and fast
  const frame = jpg(5, 30000);
  const all = [];
  for (let i = 0; i < 100; i++) all.push(...sep, ...frame);
  const buf = Uint8Array.from(all);
  let n = 0, bad = 0;
  const push = makeExtractor((f) => { n++; if (f.length !== frame.length) bad++; });
  const t = process.hrtime.bigint();
  for (let i = 0; i < buf.length; i += 1400) push(buf.subarray(i, i + 1400));
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  if (n !== 100 || bad) fail(`extractor found ${n} frames (${bad} wrong size)`);
  if (ms > 500) fail(`extractor too slow: ${ms.toFixed(0)} ms for 3 MB`);
  ok(`extractor: 100 frames x 30 kB in small chunks, ${ms.toFixed(0)} ms`);
}

// ---------- 3. fake browser + fake camera ----------
const SIZE_W = { 5: 320, 4: 240, 8: 640, 6: 400, 9: 800, 7: 480 };   // newer-table camera
function sim(page, o) {
  let now = 0;
  const timers = [], posts = [], fetched = [];
  const addT = (fn, ms, rep) => { const t = { fn, at: now + (ms || 0), ms: ms || 0, rep, live: true }; timers.push(t); return t; };
  const clr = (t) => { if (t) t.live = false; };
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      let due = null;
      for (const t of timers) if (t.live && t.at <= end && (!due || t.at < due.at)) due = t;
      if (!due) break;
      now = due.at;
      if (due.rep) due.at += Math.max(1, due.ms); else due.live = false;
      due.fn();
    }
    for (let i = timers.length - 1; i >= 0; i--) if (!timers[i].live) timers.splice(i, 1);
    now = end;
  };
  let pix = 0;
  const ctx2d = () => ({
    drawImage() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    getImageData: () => {
      const d = new Uint8ClampedArray(48 * 36 * 4);
      if (o.imgChanging) d[0] = (pix++ % 250);
      if (o.scene) for (let i = 0; i < 48 * 36; i++) { const v = o.scene(i % 48, Math.floor(i / 48)); d[i*4] = d[i*4+1] = d[i*4+2] = v; }
      return { data: d };
    },
  });
  const el = () => ({ style: {}, getContext: ctx2d, width: 0, height: 0, removeAttribute() {}, naturalWidth: o.decW || 0, naturalHeight: (o.decW || 0) * 0.75 });
  function FakeImage() {
    const im = { naturalWidth: 0, naturalHeight: 0, onload: null, onerror: null };
    let src = '';
    Object.defineProperty(im, 'src', { get: () => src, set: (v) => {
      src = v; if (!v) return;
      fetched.push({ t: now, url: v });
      if (o.photoW) addT(() => { if (src === v && im.onload) { im.naturalWidth = o.photoW; im.naturalHeight = o.photoW * 0.75; im.onload(); } }, 300);
    } });
    return im;
  }
  const win = {
    ReactNativeWebView: { postMessage: (s) => posts.push({ t: now, ...JSON.parse(s) }) },
    innerWidth: 800, innerHeight: 400, addEventListener() {}, stop() {},
    AbortController: function () { const sig = {}; this.signal = sig; this.abort = () => { sig.aborted = true; if (sig.onabort) sig.onabort(); }; },
    createImageBitmap: (b) => { const w = b && b.photo ? o.photoW : o.bmpW; return Promise.resolve({ width: w, height: w * 0.75, close() {} }); },
  };
  const doc = { getElementById: () => el(), createElement: () => el() };
  const fetchFake = (url, opt) => {
    fetched.push({ t: now, url });
    const sig = (opt && opt.signal) || {};
    if (o.down) return Promise.reject(new Error('Failed to fetch'));
    if (url.endsWith('/')) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(o.html || '<html><select id="framesize"></select></html>') });
    if (url.includes('/control')) {
      if (o.controlHangs) return new Promise((res, rej) => { sig.onabort = () => { fetched.push({ t: now, url: 'ABORTED ' + url }); rej(new Error('aborted')); }; });
      const mm = /framesize&val=(\d+)/.exec(url);
      if (mm && o.honor) o.bmpW = SIZE_W[mm[1]] || o.bmpW;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('ok') });
    }
    if (/capture|jpg|still|snapshot/.test(url)) {
      if (!o.photoW) return Promise.reject(new Error('refused'));
      const delay = o.nextPhotoDelay != null ? o.nextPhotoDelay : 300; o.nextPhotoDelay = null;
      sig.aborted = false;
      return new Promise((res, rej) => {
        sig.onabort = () => { fetched.push({ t: now, url: 'ABORTED ' + url }); rej(new Error('aborted')); };
        addT(() => { if (!sig.aborted) res({ ok: true, status: 200, blob: () => Promise.resolve({ photo: true }) }); }, delay);
      });
    }
    if (!o.streamOK || !url.includes('/stream')) return Promise.reject(new Error('refused'));
    const frame = Uint8Array.from(jpg(9, 100));
    return Promise.resolve({ ok: true, status: 200, body: { getReader: () => ({
      read: () => new Promise((res) => { if (!o.silent) addT(() => res({ done: false, value: frame }), o.frameMs || 50); }),
    }) } });
  };
  const run = new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'requestAnimationFrame', 'Blob', 'Image', 'URL', 'Date', page);
  run(win, doc, fetchFake, (f, ms) => addT(f, ms, false), clr, (f, ms) => addT(f, ms, true), clr,
    (f) => addT(f, 0, false), function () {}, FakeImage, { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, { now: () => now });
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const step = async (ms) => { for (let t = 0; t < ms; t += 20) { advance(20); await flush(); } };
  return { posts, fetched, step, o };
}
const urls = (s) => s.fetched.map((f) => f.url.replace('http://192.168.169.1', '').split('?t=')[0]);

(async () => {
  // A: camera honours the small size; then goes silent
  let s = sim(pageFor('small'), { bmpW: 640, honor: true, streamOK: true });
  await s.step(3000);
  const u = urls(s);
  const iSize = u.indexOf('/control?var=framesize&val=5'), iStream = u.indexOf('/stream');
  if (iSize < 0 || iStream < 0 || iSize > iStream) fail('size request must come before stream: ' + u.join(' | '));
  if (!s.posts.some((p) => p.type === 'size' && p.msg === '5')) fail('size ok not reported');
  if (!s.posts.some((p) => p.type === 'streaming')) fail('never went live');
  if (!s.posts.some((p) => p.type === 'res' && p.msg === '320x240')) fail('res not posted');
  ok('A: size asked before video, 320x240 confirmed, live');
  s.o.silent = true;
  await s.step(6000);
  if (!s.posts.some((p) => p.type === 'reconnecting')) fail('no reconnecting after silence');
  if (s.posts.some((p) => p.type === 'error')) fail('error posted too early');
  await s.step(55000);
  const err = s.posts.find((p) => p.type === 'error');
  if (!err || err.msg !== 'lost') fail('expected error lost, got ' + JSON.stringify(err));
  ok('A: silence => reconnecting, then "lost" after 45 s');

  // B: camera ignores the size: tries the other code, then gives up and still shows video
  s = sim(pageFor('small'), { bmpW: 640, streamOK: true });
  await s.step(6000);
  const ub = urls(s);
  if (!ub.includes('/control?var=framesize&val=5') || !ub.includes('/control?var=framesize&val=4')) fail('both codes not tried: ' + ub.join(' | '));
  if (!s.posts.some((p) => p.type === 'size' && p.msg === 'none')) fail('size none not reported');
  if (!s.posts.some((p) => p.type === 'streaming')) fail('B never went live');
  ok('B: size ignored => other code tried, then video at camera size');

  // C: size request hangs: aborted after 2 s, video still starts
  s = sim(pageFor('small'), { bmpW: 320, streamOK: true, controlHangs: true });
  await s.step(6000);
  const ab = s.fetched.find((f) => f.url.startsWith('ABORTED') && f.url.includes('framesize'));
  if (!ab || ab.t > 2100) fail('hanging size request not aborted at 2 s: ' + JSON.stringify(ab));
  const live = s.posts.find((p) => p.type === 'streaming');
  if (!live || live.t > 5000) fail('C went live late or never: ' + JSON.stringify(live));
  ok(`C: hanging size request cancelled at ${ab.t / 1000} s, live at ${live.t / 1000} s`);

  // D: no video at start => photo mode; video comes back => switches to video within ~20 s
  s = sim(pageFor('small', '5'), { bmpW: 320, photoW: 320, streamOK: false });
  await s.step(15000);
  const ph = s.posts.find((p) => p.type === 'streaming');
  if (!ph || ph.msg !== 'photos') fail('D expected photo mode: ' + JSON.stringify(s.posts.filter((p) => p.type !== 'log')));
  s.o.streamOK = true;
  const before = s.posts.length;
  await s.step(25000);
  const after = s.posts.slice(before);
  if (!after.some((p) => p.type === 'streaming' && p.msg === 'video')) fail('D did not switch back to video');
  if (!after.some((p) => p.type === 'method' && p.msg.startsWith('fetch'))) fail('D new method not saved');
  ok('D: photo mode switches back to video when it works');

  // G: basic <img> video method is no longer capped at ~8 fps
  s = sim(pageFor('small'), { bmpW: 320, decW: 320, imgChanging: true, streamOK: false });
  await s.step(12000);
  const fpsG = Math.max(0, ...s.posts.filter((p) => p.type === 'fps').map((p) => Number(p.msg)));
  if (!s.posts.some((p) => p.type === 'method' && p.msg.startsWith('img'))) fail('G did not use the img method');
  if (fpsG <= 8) fail('img method still capped: ' + fpsG + ' fps');
  ok(`G: basic video method reaches ${fpsG} fps (was max 8)`);

  // E: speed test, camera honours sizes, 25 fps stream
  s = sim(pageFor('small', null, true), { bmpW: 640, honor: true, streamOK: true, photoW: 320, frameMs: 40 });
  await s.step(80000);
  let tp = s.posts.find((p) => p.type === 'test');
  if (!tp) fail('E: no test result. Log: ' + s.posts.filter((p) => p.type === 'log').map((p) => p.msg).join(' | '));
  let R = JSON.parse(tp.msg);
  const ws = R.video.map((v) => v.w).join(',');
  if (R.video.length !== 3 || ws !== '320,640,800') fail('E: video rows wrong: ' + JSON.stringify(R.video));
  if (!R.ping || R.ping.miss !== 0) fail('E: ping wrong ' + JSON.stringify(R.ping));
  if (!R.photo || !R.photo.ok) fail('E: photo step failed ' + JSON.stringify(R.photo));
  if (!(R.video[0].fps >= 20 && R.video[0].kbps > 0 && R.video[0].kb > 0)) fail('E: numbers missing ' + JSON.stringify(R.video[0]));
  const phases = s.posts.filter((p) => p.type === 'phase').map((p) => JSON.parse(p.msg).label);
  if (!phases.some((l) => /step 6 of 6/.test(l))) fail('E: phases ' + phases.join(' | '));
  let F = S.findings(R);
  if (!F.some((f) => f.level === 'good')) fail('E: expected a good finding: ' + JSON.stringify(F));
  if (F.some((f) => /accept size/.test(f.text))) fail('E: wrongly says sizes unsupported');
  if (F.some((f) => /Weak Wi-Fi/.test(f.text))) fail('E: wrongly blames Wi-Fi at 25 fps');
  if (!S.bestSize(R)) fail('E: no best size');
  const lastSize = urls(s).filter((x) => x.includes('framesize')).pop();
  if (lastSize !== '/control?var=framesize&val=5') fail('E: user size not restored, last was ' + lastSize);
  if (!/What to fix/.test(S.reportText(R))) fail('E: report text');
  ok(`E: speed test: 6 steps, Small ${R.video[0].fps} fps / Medium ${R.video[1].fps} / Large ${R.video[2].fps}, size restored`);

  // F: speed test, camera ignores sizes
  s = sim(pageFor('small', null, true), { bmpW: 640, streamOK: true, photoW: 640, frameMs: 250 });
  await s.step(90000);
  tp = s.posts.find((p) => p.type === 'test');
  if (!tp) fail('F: no test result');
  R = JSON.parse(tp.msg);
  F = S.findings(R);
  if (!F.some((f) => /accept size changes/.test(f.text))) fail('F: expected "doesn\'t accept size changes": ' + JSON.stringify(F));
  if (!F.some((f) => f.level === 'bad' && /Low/.test(f.text))) fail('F: expected low fps finding: ' + JSON.stringify(F));
  ok('F: speed test says the camera ignores size changes and fps is low');

  // H: speed test, no video at all, photos work
  s = sim(pageFor('small', null, true), { bmpW: 320, streamOK: false, photoW: 320 });
  await s.step(120000);
  tp = s.posts.find((p) => p.type === 'test');
  if (!tp) fail('H: no test result');
  F = S.findings(JSON.parse(tp.msg));
  if (!F.some((f) => /only photo mode/.test(f.text))) fail('H: expected photo-only finding: ' + JSON.stringify(F));
  ok('H: speed test says video does not work, only photo mode');

  // I: obstacle: something big covers the left part => only left turns red; it clears when removed
  const tex = (x, y) => (x * 37 + y * 91 + ((x * y) % 7) * 20) % 255;
  s = sim(pageFor('small', 'none'), { bmpW: 320, streamOK: true, scene: tex });
  await s.step(3000);
  const obsNow = () => { const o2 = s.posts.filter((p) => p.type === 'obs').pop(); return o2 ? JSON.parse(o2.msg).b.join('') : '000'; };
  if (obsNow() !== '000') fail('I: false alarm on a still scene: ' + obsNow());
  s.o.scene = (x, y) => (x < 16 ? 40 + (y % 3) : tex(x, y));
  await s.step(1500);
  if (obsNow() !== '100') fail('I: expected left blocked, got ' + obsNow());
  s.o.scene = (x, y) => (x >= 8 && x < 40 ? 200 - (x % 2) * 5 : tex(x, y));   // something big in the middle
  await s.step(1500);
  if (obsNow()[1] !== '1') fail('I: expected front blocked, got ' + obsNow());
  s.o.scene = tex;
  await s.step(1500);
  if (obsNow() !== '000') fail('I: alarm did not clear: ' + obsNow());
  // whole picture brighter (auto exposure) must not alarm
  s.o.scene = (x, y) => Math.min(255, tex(x, y) * 0.6 + 90);
  await s.step(1500);
  if (obsNow() !== '000') fail('I: brightness change caused an alarm: ' + obsNow());
  ok('I: obstacle detection: left / front alarms, clears, ignores brightness changes');

  // J: photo mode pipelines requests (camera size 1600x1200 shown at 800 wide)
  s = sim(pageFor('small', 'none'), { bmpW: 1600, photoW: 1600, streamOK: false });
  await s.step(20000);
  const fpsJ = Math.max(0, ...s.posts.filter((p) => p.type === 'fps').map((p) => Number(p.msg)));
  if (!s.posts.some((p) => p.type === 'streaming' && p.msg === 'photos')) fail('J: no photo mode');
  if (fpsJ < 3) fail('J: photo mode too slow in simulation: ' + fpsJ);
  if (urls(s).some((x) => x.includes('/control'))) fail('J: size requests sent although camera ignores them');
  ok(`J: photo mode ${fpsJ} photos/s with 300 ms per photo; no useless size requests`);

  // K: like an ultrasonic sensor: left % rises step by step as something covers more, falls as it leaves
  s = sim(pageFor('small', 'none'), { bmpW: 320, streamOK: true, scene: tex });
  await s.step(3000);
  const lvlNow = () => { const p = s.posts.filter((x) => x.type === 'lvl').pop(); return p ? JSON.parse(p.msg) : [0, 0, 0]; };
  const leftAt = [];
  for (const cols of [3, 7, 11, 16, 11, 7, 3, 0]) {         // object grows to fill the left part, then leaves
    s.o.scene = (x, y) => (x < cols ? 40 + (y % 3) : tex(x, y));
    await s.step(2000);
    leftAt.push(lvlNow()[0]);
  }
  const up = leftAt.slice(0, 4), down = leftAt.slice(3);
  if (!up.every((v, i) => i === 0 || v > up[i - 1])) fail('K: % did not rise while coming closer: ' + leftAt.join(','));
  if (!down.every((v, i) => i === 0 || v < down[i - 1])) fail('K: % did not fall while moving away: ' + leftAt.join(','));
  if (leftAt[3] < 90 || leftAt[7] > 10) fail('K: range wrong: ' + leftAt.join(','));
  if (lvlNow()[1] > 10 || lvlNow()[2] > 10) fail('K: front/right moved: ' + lvlNow().join(','));
  ok('K: left closeness % while approaching and leaving: ' + leftAt.join('% ') + '%');

  // L: stock camera firmware: never opens /stream or sends size requests; live in photo mode fast
  s = sim(pageFor('small'), { bmpW: 1600, photoW: 1600, streamOK: false, html: '<button>Start Stream</button><select id="framesize"></select>' });
  await s.step(30000);
  const liveL = s.posts.find((p) => p.type === 'streaming');
  if (!liveL || liveL.msg !== 'photos' || liveL.t > 1500) fail('L: not live in photo mode quickly: ' + JSON.stringify(liveL));
  if (urls(s).some((x) => x.includes('/stream') || x.includes('/control'))) fail('L: touched /stream or /control: ' + urls(s).filter((x) => !x.includes('capture')).join(' | '));
  if (s.posts.some((p) => p.type === 'reconnecting')) fail('L: reconnecting happened');
  ok(`L: stock firmware: live in photo mode after ${liveL.t / 1000} s, no /stream, no reconnects in 30 s`);

  const stockHtml = '<button>Start Stream</button><select id="framesize"></select>';
  // M: one photo takes 6 s: no "reconnecting", a "slow" note then "ok", and that photo is not aborted
  s = sim(pageFor('small', 'none'), { bmpW: 1600, photoW: 1600, streamOK: false, html: stockHtml });
  await s.step(5000);
  s.o.nextPhotoDelay = 6000;
  await s.step(12000);
  if (s.posts.some((p) => p.type === 'reconnecting')) fail('M: slow photo caused reconnecting');
  const slowP = s.posts.find((p) => p.type === 'slow'), okP = s.posts.find((p) => p.type === 'ok');
  if (!slowP || !okP || okP.t < slowP.t) fail('M: expected slow then ok: ' + JSON.stringify([slowP, okP]));
  if (s.fetched.some((x) => x.url.startsWith('ABORTED'))) fail('M: slow photo was aborted');
  ok(`M: a 6 s photo shows "camera slow" at ${(slowP.t / 1000).toFixed(1)} s, no reconnect, not aborted`);

  // N: camera gone for 15 s (restart / Wi-Fi drop): reconnecting after ~10 s, then live again, no error
  s = sim(pageFor('small', 'none'), { bmpW: 1600, photoW: 1600, streamOK: false, html: stockHtml });
  await s.step(5000);
  const tDown = 5000; s.o.photoW = 0; s.o.down = true;
  await s.step(15000);
  const rc = s.posts.find((p) => p.type === 'reconnecting');
  if (!rc || rc.t - tDown < 9000 || rc.t - tDown > 12000) fail('N: reconnecting at wrong time: ' + JSON.stringify(rc));
  s.o.photoW = 1600; s.o.down = false;
  await s.step(5000);
  const back = s.posts.filter((p) => p.type === 'streaming').pop();
  if (!back || back.t < tDown + 15000) fail('N: did not come back');
  if (s.posts.some((p) => p.type === 'error')) fail('N: error shown for a 15 s outage');
  ok(`N: 15 s outage: reconnecting after ${((rc.t - tDown) / 1000).toFixed(1)} s, picture back ${((back.t - tDown - 15000) / 1000).toFixed(1)} s after the camera returned`);

  // O: stock firmware only ever asks /capture (no /jpg /still /snapshot), also while reconnecting
  if (urls(s).some((x) => /\/(jpg|still|snapshot)/.test(x))) fail('O: other photo paths used: ' + [...new Set(urls(s))].join(' | '));
  ok('O: stock firmware: only /capture is used, also when reconnecting');

  // P: phone not yet routed to the camera for 8 s after start: waits, then goes live, no "unreachable"
  s = sim(pageFor('small', 'none'), { bmpW: 1600, photoW: 1600, streamOK: false, html: stockHtml, down: true });
  await s.step(8000);
  const waitPhase = s.posts.some((p) => p.type === 'phase' && /Waiting for camera Wi-Fi/.test(p.msg));
  s.o.down = false;
  await s.step(6000);
  if (s.posts.some((p) => p.type === 'error')) fail('P: unreachable error although camera came within 20 s');
  if (!waitPhase) fail('P: no "Waiting for camera Wi-Fi" step shown');
  if (!s.posts.some((p) => p.type === 'streaming')) fail('P: never went live');
  ok('P: camera reachable only after 8 s: "Waiting for camera Wi-Fi...", then live, no error');

  // Q: still "unreachable" when the camera never answers (after 20 s, not forever)
  s = sim(pageFor('small', 'none'), { bmpW: 1600, photoW: 1600, streamOK: false, html: stockHtml, down: true });
  await s.step(25000);
  const un = s.posts.find((p) => p.type === 'error' && p.msg === 'unreachable');
  if (!un || un.t < 18000 || un.t > 23000) fail('Q: unreachable at wrong time: ' + JSON.stringify(un));
  ok(`Q: camera never answers: "not connected" screen after ${(un.t / 1000).toFixed(1)} s`);

  // R: camera reflashed with real-video firmware (page has no "framesize"); the phone still remembers
  //    "photo /capture" from the old software: must go live via /stream video, no /control requests
  const pageR = V.viewerHtml('192.168.169.1', true, 'photo http://192.168.169.1/capture', 'small', null, false).split('<script>')[1].split('</script>')[0];
  s = sim(pageR, { bmpW: 800, photoW: 800, streamOK: true, frameMs: 55, html: '<html><img src="/stream"></html>' });
  await s.step(8000);
  const liveR = s.posts.find((p) => p.type === 'streaming');
  if (!liveR || liveR.msg !== 'video') fail('R: not live via video: ' + JSON.stringify(liveR));
  if (urls(s).some((x) => x.includes('/control'))) fail('R: size request sent to a camera without size control');
  if (urls(s).indexOf('/stream') > urls(s).indexOf('/capture') && urls(s).includes('/capture')) fail('R: photo tried before video');
  const fpsR = Math.max(0, ...s.posts.filter((p) => p.type === 'fps').map((p) => Number(p.msg)));
  if (fpsR < 15) fail('R: video fps too low in simulation: ' + fpsR);
  ok(`R: reflashed camera: video via /stream after ${(liveR.t / 1000).toFixed(1)} s, ${fpsR} fps, no /control, old photo preference ignored`);

  console.log('\nAll checks passed.');
})().catch((e) => fail(e.stack));
