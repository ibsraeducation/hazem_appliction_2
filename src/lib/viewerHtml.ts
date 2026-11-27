// Pulls complete JPEGs (FF D8 … FF D9) out of an MJPEG byte stream and reports only the
// newest one per chunk, so a slow screen never builds up a backlog (= no growing delay).
// Each byte is scanned once and each frame copied once (no re-copying of the unfinished frame
// on every network chunk); markers split across two chunks are handled.
// Kept as plain ES5 source so the same text runs inside the WebView and in Node tests.
export const FRAME_EXTRACTOR_JS = `
function makeExtractor(onFrame){
  var parts = [], size = 0, inFrame = false, prev = -1;
  function join(last){
    var out = new Uint8Array(size + last.length), o = 0, k;
    for (k = 0; k < parts.length; k++) { out.set(parts[k], o); o += parts[k].length; }
    out.set(last, o);
    return out;
  }
  return function push(chunk){
    var latest = null, from = inFrame ? 0 : -1, i, b;
    for (i = 0; i < chunk.length; i++) {
      b = chunk[i];
      if (prev === 0xFF) {
        if (b === 0xD8 && !inFrame) {
          inFrame = true; parts = []; size = 0; from = i - 1;
          if (from < 0) { parts.push(new Uint8Array([0xFF])); size = 1; from = 0; }  // FF was the last byte of the previous chunk
        } else if (b === 0xD9 && inFrame) {
          latest = join(chunk.subarray(from, i + 1));
          inFrame = false; parts = []; size = 0; from = -1;
        }
      }
      prev = b;
    }
    if (inFrame) {
      parts.push(chunk.slice(from)); size += chunk.length - from;
      if (size > 4000000) { inFrame = false; parts = []; size = 0; }   // garbage guard
    }
    if (latest) onFrame(latest);
  };
}
`;

// Timings (ms). Exported so the app's loading screen can estimate time left.
export const T = {
  probe: 3000, // one camera check must answer within this
  probeFor: 20000, // keep checking this long (Wi-Fi may still be joining) before "not connected"
  firstVideo: 6000, // a video method must deliver its first frame within this
  firstPhoto: 8000, // a photo path must deliver its first photo within this (1600x1200 photos are slow)
  photo: 10000, // while live, one photo may take this long before it is retried
  stall: 4000, // video: no frame for this long while live => reconnect
  stallPhoto: 10000, // photo mode: no photo for this long => reconnect (a slow photo is not a disconnect)
  slow: 3000, // photo mode: no photo for this long => small "camera slow" note
  giveUp: 45000, // reconnecting for this long => "picture stopped" error (a camera restart takes ~20 s)
};

/**
 * Builds the WebView page that finds a working way to get pictures from the camera and shows them.
 *
 * Flow: probe the camera (GET /) → try each method in order until one delivers frames:
 *   video via fetch (newest frame only, decoded off the main thread) → video via <img> →
 *   the same on port 81 → photo polling on the paths the camera page mentions.
 * The method that worked last time (`preferred`) is tried first.
 * Every request is abortable, so nothing is left blocking the single-connection camera.
 * Frames are always drawn on one canvas. A watchdog turns silence into "reconnecting",
 * and after T.giveUp of reconnecting into a "lost" error.
 *
 * Messages to the app (type: msg):
 *   phase {i,n,label,ms} | streaming label | method id | reconnecting | fps "N" |
 *   obs {b:[l,f,r]} | dbg text | cal ratio | log text | error unreachable|novideo|lost |
 *   res "WxH" | size code|none | slow (photo late) | ok (pictures again)
 *
 * Picture size: the camera's firmware is unknown, so a smaller size is asked for with the
 * ESP32-style /control command (codes for both common numberings) and the first frame's
 * width is checked. A code is kept only if the picture really is that small.
 */
export type PicSize = 'small' | 'medium' | 'large';

// Speed & quality test (runs instead of the normal viewer when test = true).
// 6 steps: connection, video at Small / Medium / Large, photo mode, restore size.
// Posts phase messages while running and one `test` JSON result at the end (see speedTest.ts).
const TEST_JS = `
  function runTest(){
    var R = {ping: null, video: [], photo: null, method: ''}, N = 6;
    function phase(k, label, ms){ post('phase', JSON.stringify({i: k, n: N, ms: ms, label: 'Testing - step ' + (k + 1) + ' of ' + N + ': ' + label})); }
    function r1(v){ return Math.round(v * 10) / 10; }

    // runs one method: first frame within 6 s, then counts for 5 s
    function measure(m, done){
      var st = {recv: 0, bytes: 0, dec: 0, decN: 0}, drawn = 0, w = 0, h = 0, first = 0, last = 0, gap = 0, fin = false, hd = null, t = null;
      m.stats = st;
      t = setTimeout(function(){ end(drawn ? '' : 'no picture in 6 s'); }, 6000);
      hd = IMPL[m.kind](m, function(pic, W, H){
        if (fin) return;
        var now = Date.now();
        if (!first) { first = now; clearTimeout(t); t = setTimeout(function(){ end(''); }, 5000); }
        else gap = Math.max(gap, now - last);
        last = now; drawn++; w = W; h = H;
        try { paint(pic, W, H); } catch(e){}
      }, function(reason){ end(reason || 'failed'); });
      function end(err){
        if (fin) return; fin = true; clearTimeout(t); if (hd) hd.stop(); delete m.stats;
        var secs = first ? Math.max(0.001, (Date.now() - first) / 1000) : 0;
        var res = {ok: drawn > 1, fps: drawn > 1 && last > first ? r1((drawn - 1) / ((last - first) / 1000)) : 0, w: w, h: h,
          recv: st.recv, drawn: drawn, kb: st.recv ? r1(st.bytes / st.recv / 1024) : null,
          kbps: st.recv && secs ? Math.round(st.bytes / 1024 / secs) : null, gap: gap,
          dec: st.decN ? Math.round(st.dec / st.decN) : null, err: drawn > 1 ? '' : (err || 'no picture'), method: m.id};
        log('test ' + m.id + ': ' + JSON.stringify(res));
        setTimeout(function(){ done(res); }, 300);   // let the camera close the connection
      }
    }
    function firstOk(cands, i, done){
      if (i >= cands.length) { done(null); return; }
      measure(cands[i], function(res){ if (res.ok) done(res, cands[i]); else if (i + 1 < cands.length && i < 2) firstOk(cands, i + 1, done); else done(res); });
    }

    // 1. connection
    phase(0, 'connection', 2000);
    var times = [], miss = 0, n = 0;
    (function one(){
      if (n++ >= 5) {
        var avg = times.length ? Math.round(times.reduce(function(a, b){ return a + b; }, 0) / times.length) : 0;
        R.ping = {avg: avg, worst: times.length ? Math.max.apply(null, times) : 0, miss: miss};
        video(0, null);
        return;
      }
      var t1 = Date.now();
      ping(BASE + '/', 3000).then(function(){ times.push(Date.now() - t1); setTimeout(one, 100); },
                                  function(){ miss++; setTimeout(one, 100); });
    })();

    // 2-4. video at each size (both firmware codes tried if the first does nothing)
    var names = ['small', 'medium', 'large'], vids = list.filter(function(x){ return x.kind !== 'photo'; });
    if (PREF) vids.sort(function(a, b){ return (b.id === PREF) - (a.id === PREF); });
    function video(k, method){
      if (k >= names.length) { photosStep(); return; }
      var sz = SIZES[names[k]];
      phase(k + 1, 'video ' + names[k], 12000);
      function tryCode(ci){
        sendSize(sz.codes[ci], function(){
          var after = function(res, m){
            res = res || {ok: false, fps: 0, err: 'no video method works', method: ''};
            res.size = names[k]; res.code = sz.codes[ci];
            if (res.ok && res.w > sz.w * 1.3 && ci + 1 < sz.codes.length) { tryCode(ci + 1); return; }
            res.sizeOk = res.ok ? res.w <= sz.w * 1.3 : false;
            R.video.push(res);
            video(k + 1, m || method);
          };
          if (method) measure(method, function(res){ after(res, method); });
          else firstOk(vids, 0, after);
        });
      }
      tryCode(0);
    }

    // 5. photo mode
    function photosStep(){
      phase(4, 'photo mode', 6000);
      var ph = list.filter(function(x){ return x.kind === 'photo'; });
      firstOk(ph, 0, function(res){ R.photo = res; restore(); });
    }

    // 6. back to the user's size
    function restore(){
      phase(5, 'finishing', 1000);
      var c = SAVED ? Number(SAVED) : CODES[0];
      var fin = function(){
        var best = R.video.filter(function(v){ return v.ok; }).sort(function(a, b){ return b.fps - a.fps; })[0];
        R.method = best ? best.method : '';
        log('test done');
        post('test', JSON.stringify(R)); stopAll();
      };
      if (c) sendSize(c, fin); else fin();
    }
  }
`;

export function viewerHtml(
  host: string,
  active: boolean,
  preferred: string | null = null,
  size: PicSize = 'small',
  sizeCode: string | null = null,
  test = false,
): string {
  const base = `http://${host}`;
  return `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden}
  #view{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain}
  #dec{position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none}
</style></head>
<body><canvas id="view"></canvas><img id="dec" alt="">
<script>
  ${FRAME_EXTRACTOR_JS}
  var BASE = ${JSON.stringify(base)};
  var HOST = ${JSON.stringify(host)}.replace(/:\\d+$/, '');
  var ACTIVE = ${active ? 'true' : 'false'};
  var PREF = ${JSON.stringify(preferred)};
  var T = ${JSON.stringify(T)};
  // framesize codes: [newer esp32-camera table, older table]. Small = QVGA 320x240, Medium = VGA 640x480, Large = SVGA 800x600.
  var SIZES = {small: {w: 320, codes: [5, 4]}, medium: {w: 640, codes: [8, 6]}, large: {w: 800, codes: [9, 7]}};
  var TEST = ${test ? 'true' : 'false'};
  var TARGET = SIZES[${JSON.stringify(size)}].w;
  var CODES = SIZES[${JSON.stringify(size)}].codes.slice();
  var SAVED = ${JSON.stringify(sizeCode)};
  if (SAVED === 'none' && !TEST) CODES = [];   // this camera ignores size requests: don't waste time on them
  if (SAVED && CODES.indexOf(Number(SAVED)) > 0) CODES.unshift(CODES.splice(CODES.indexOf(Number(SAVED)), 1)[0]);
  var sizeIdx = 0, sizeState = 'off';   // off | checking | done
  var view = document.getElementById('view'), vctx = view.getContext('2d');
  var dec = document.getElementById('dec');
  var stopped = false, live = false, mode = 'start', lastFrameAt = 0, reconnStart = 0;
  var frames = 0, cur = null, list = [], round = 0, t0 = Date.now(), liveId = '', upIdx = 0;
  var liveKind = '', slowShown = false, pst = {n: 0, sum: 0, max: 0, retry: 0}, tenFrames = 0;

  function post(type, msg){
    try { window.ReactNativeWebView.postMessage(JSON.stringify({type:type, msg:msg == null ? '' : String(msg)})); } catch(e){}
  }
  function log(s){ post('log', ((Date.now() - t0) / 1000).toFixed(1) + 's ' + s); }

  // Abortable fetch with a hard timeout: never leaves a request hanging on the camera.
  function fetchT(url, ms){
    var c = window.AbortController ? new AbortController() : null;
    var to = setTimeout(function(){ try { c && c.abort(); } catch(e){} }, ms);
    return fetch(url, c ? {signal: c.signal, cache: 'no-store'} : {cache: 'no-store'})
      .then(function(r){ clearTimeout(to); return r; }, function(e){ clearTimeout(to); throw e; });
  }
  // Short command: whole request (incl. body) is cancelled after ms, so the camera is free again.
  function ping(url, ms){
    var c = window.AbortController ? new AbortController() : null;
    var to = setTimeout(function(){ try { c && c.abort(); } catch(e){} }, ms);
    return fetch(url, c ? {signal: c.signal, cache: 'no-store'} : {cache: 'no-store'})
      .then(function(r){ return r.text().then(function(){ return r.status; }); })
      .then(function(s){ clearTimeout(to); return s; }, function(e){ clearTimeout(to); throw e; });
  }
  function sendSize(code, done){
    var fin = function(){ setTimeout(done, 200); };
    ping(BASE + '/control?var=framesize&val=' + code, 2000).then(function(s){
      log('size ' + code + ' -> ' + s);
      return ping(BASE + '/control?var=quality&val=12', 2000).then(fin, fin);
    }, function(e){ log('size ' + code + ' failed: ' + (e && e.message ? e.message : e)); fin(); });
  }

  // ---- Display: every frame goes onto the one canvas ----
  function paint(pic, w, h){
    if (view.width !== w || view.height !== h) { view.width = w; view.height = h; post('res', w + 'x' + h); }
    vctx.drawImage(pic, 0, 0, w, h);
  }

  // ---- Turn / mirror (camera may be mounted sideways or flipped). Called from the app. ----
  var ROT = 0, FLIP = false;
  function applyView(){
    var w = window.innerWidth, h = window.innerHeight, st = view.style;
    if (ROT % 180) { st.width = h + 'px'; st.height = w + 'px'; st.left = (w - h) / 2 + 'px'; st.top = (h - w) / 2 + 'px'; }
    else { st.width = w + 'px'; st.height = h + 'px'; st.left = '0px'; st.top = '0px'; }
    st.transform = 'rotate(' + ROT + 'deg)' + (FLIP ? ' scaleX(-1)' : '');
  }
  window.setView = function(r, f){
    if (r === ROT && f === FLIP) return;
    ROT = r; FLIP = f; resetRef(); applyView();
  };
  window.addEventListener('resize', applyView);
  applyView();

  // ---- Obstacle check ----
  // Change detection: the app keeps a small "clear view" picture (48x36, brightness-normalised so
  // auto-exposure doesn't count). A part (left / front / right) is blocked when a large share of
  // it differs strongly from that clear view, i.e. something big has come close in front of it.
  // That share is the part's closeness % (0-100); the alarm % is set in the app.
  var oc = document.createElement('canvas'); oc.width = 48; oc.height = 36;
  var octx = oc.getContext('2d');
  var NPX = 48 * 36, g = new Float32Array(NPX), ref = null, refS = [0, 0, 0], ZONE = new Uint8Array(NPX);
  for (var zi = 0; zi < NPX; zi++) ZONE[zi] = Math.floor((zi % 48) / 16);   // left / front / right
  var lvl = [0, 0, 0], lastA = 0, lastDbg = 0, hits = [0, 0, 0], obsKey = '', lvlKey = '';
  function resetRef(){ ref = null; hits = [0, 0, 0]; lvl = [0, 0, 0]; }
  window.resetRef = resetRef;
  function analyze(){
    var now = Date.now(); if (now - lastA < 200) return; lastA = now;
    if (!view.width) return;
    var d;
    try {
      // analyse exactly what the user sees (same turn + mirror)
      octx.save(); octx.translate(24, 18); octx.rotate(ROT * Math.PI / 180); if (FLIP) octx.scale(-1, 1);
      if (ROT % 180) octx.drawImage(view, -18, -24, 36, 48); else octx.drawImage(view, -24, -18, 48, 36);
      octx.restore();
      d = octx.getImageData(0, 0, 48, 36).data;
    } catch(e){ return; }
    var i, k, m = [0, 0, 0], s = [0, 0, 0], cnt = [0, 0, 0];
    for (i = 0; i < NPX; i++) { k = ZONE[i]; g[i] = d[i*4]*0.3 + d[i*4+1]*0.59 + d[i*4+2]*0.11; m[k] += g[i]; cnt[k]++; }
    for (k = 0; k < 3; k++) m[k] /= cnt[k];
    for (i = 0; i < NPX; i++) { k = ZONE[i]; s[k] += (g[i] - m[k]) * (g[i] - m[k]); }
    for (k = 0; k < 3; k++) s[k] = Math.sqrt(s[k] / cnt[k]) + 4;
    // brightness-normalised per part: exposure changes and changes in another part don't count
    for (i = 0; i < NPX; i++) { k = ZONE[i]; g[i] = (g[i] - m[k]) / s[k]; }
    if (!ref) { ref = new Float32Array(g); refS = s.slice(); return; }
    var bad = [0, 0, 0], n = [0, 0, 0];
    for (i = 0; i < NPX; i++) {
      k = ZONE[i];
      n[k]++;
      if (Math.abs(g[i] - ref[i]) > 0.8) bad[k]++;
    }
    // closeness % per part, like an ultrasonic sensor: grows as something comes closer
    // (covers more of that part), falls as it moves away. Smoothed so the number doesn't jump.
    var alarm = window.ALARM || 0.4, blocked = [];
    for (k = 0; k < 3; k++) {
      // a plain surface (wall, cloth) close to the lens also hides the detail that part normally has
      // (only a big loss counts: exposure changes reduce contrast a little too)
      var flat = Math.max(0, Math.min(1, (0.6 - s[k] / refS[k]) / 0.5));
      lvl[k] = lvl[k] * 0.4 + Math.max(bad[k] / n[k], flat) * 0.6;
      hits[k] = lvl[k] >= alarm ? Math.min(hits[k] + 1, 5) : 0;
      blocked.push(hits[k] >= 2 ? 1 : 0);                      // 2 checks in a row: no flicker alarms
    }
    // the clear view slowly follows changes (light, small camera moves) only in nearly empty parts,
    // so someone standing in front keeps their % instead of fading away
    for (i = 0; i < NPX; i++) {
      k = ZONE[i];
      if (lvl[k] < 0.15) ref[i] = ref[i] * 0.97 + g[i] * 0.03;
    }
    for (k = 0; k < 3; k++) if (lvl[k] < 0.15) refS[k] = refS[k] * 0.97 + s[k] * 0.03;
    var pct = lvl.map(function(v){ return Math.min(100, Math.round(v * 100)); }), pk = pct.join(',');
    if (pk !== lvlKey) { lvlKey = pk; post('lvl', JSON.stringify(pct)); }
    if (window.DBG && now - lastDbg > 1000) {
      lastDbg = now;
      post('dbg', pct.join('% / ') + '% (alarm at ' + Math.round(alarm * 100) + '%)');
    }
    var key = blocked.join('');
    if (key !== obsKey) { obsKey = key; post('obs', JSON.stringify({b: blocked})); }
  }
  // ---- A frame was decoded: show it and keep the health state up to date ----
  function onFrame(pic, w, h, m){
    if (stopped || !(w > 0 && h > 0)) return;
    if (sizeState === 'checking') {
      if (w <= TARGET * 1.3) { sizeState = 'done'; log('size ok ' + w + 'x' + h); post('size', String(CODES[sizeIdx])); }
      else if (++sizeIdx < CODES.length) { log('picture still ' + w + 'x' + h + ', trying other size code'); if (cur) cur.end('resize'); return; }
      else { sizeState = 'done'; log('size not supported (' + w + 'x' + h + ')'); post('size', 'none'); }
    }
    try { paint(pic, w, h); } catch(e){ return; }
    lastFrameAt = Date.now(); frames++;
    if (slowShown) { slowShown = false; post('ok'); }
    if (!live || m.id !== liveId) {
      if (reconnStart) log('picture back after ' + ((Date.now() - reconnStart) / 1000).toFixed(1) + ' s');
      live = true; mode = 'live'; reconnStart = 0; liveId = m.id; liveKind = m.kind;
      log('live via ' + m.id + ' ' + w + 'x' + h);
      post('streaming', m.kind === 'photo' ? 'photos' : 'video');
      post('method', m.id);
    }
    analyze();
  }

  var lastFps = -1, tick10 = 0;
  setInterval(function(){
    if (live && !stopped && frames !== lastFps) { post('fps', frames); lastFps = frames; }
    if (!live) lastFps = -1;
    tenFrames += frames; frames = 0;
    // every 10 s one health line for the diagnostics
    if (++tick10 >= 10) {
      tick10 = 0;
      if (!stopped && (live || mode === 'reconnect')) {
        log('10s: ' + tenFrames + ' pictures' + (pst.n ? ', photo avg ' + Math.round(pst.sum / pst.n) + ' ms, max ' + pst.max + ' ms' : '') + (pst.retry ? ', ' + pst.retry + ' retries' : ''));
      }
      tenFrames = 0; pst = {n: 0, sum: 0, max: 0, retry: 0};
    }
  }, 1000);

  // ---- Methods. Each returns {stop}; calls frame(pic,w,h) per frame and fail(reason) once. ----
  function fetchVideo(m, frame, fail){
    var c = window.AbortController ? new AbortController() : null, dead = false, pending = null, busy = false;
    var useBitmap = typeof window.createImageBitmap === 'function';
    function draw(){
      if (!pending || busy || dead) return;
      var blob = new Blob([pending], {type: 'image/jpeg'}); pending = null; busy = true;
      var st = m.stats, t1 = Date.now();
      var next = function(){ busy = false; if (pending) requestAnimationFrame(draw); };
      if (useBitmap) {
        window.createImageBitmap(blob).then(function(bmp){
          if (st) { st.dec += Date.now() - t1; st.decN++; }
          if (!dead) frame(bmp, bmp.width, bmp.height);
          if (bmp.close) bmp.close();
          next();
        }, function(){ useBitmap = false; next(); });
      } else {
        var u = URL.createObjectURL(blob), im = new Image();
        im.onload = function(){ if (st) { st.dec += Date.now() - t1; st.decN++; } if (!dead) frame(im, im.naturalWidth, im.naturalHeight); URL.revokeObjectURL(u); next(); };
        im.onerror = function(){ URL.revokeObjectURL(u); next(); };
        im.src = u;
      }
    }
    var push = makeExtractor(function(f){
      if (m.stats) { m.stats.recv++; m.stats.bytes += f.length; }   // speed test numbers
      pending = f; requestAnimationFrame(draw);
    });
    function die(reason){ if (dead) return; dead = true; try { c && c.abort(); } catch(e){} fail(reason); }
    fetch(m.url + '?t=' + Date.now(), c ? {signal: c.signal, cache: 'no-store'} : {cache: 'no-store'}).then(function(r){
      if (!r.ok) throw new Error('http ' + r.status);
      if (!r.body || !r.body.getReader) throw new Error('noreader');
      var reader = r.body.getReader();
      (function pump(){
        reader.read().then(function(res){
          if (dead) return;
          if (res.done) { die('ended'); return; }
          push(res.value); pump();
        }, function(){ die('read error'); });
      })();
    }).catch(function(e){ die(e && e.message ? e.message : 'fetch failed'); });
    return { stop: function(){ dead = true; try { c && c.abort(); } catch(e){} } };
  }

  // Browser-decoded MJPEG (used when fetch can't read the stream, e.g. other port / no CORS).
  // New frames are detected by a tiny pixel checksum; reconnects every 10 s to drop any backlog.
  function imgVideo(m, frame, fail){
    var dead = false, sum = -1, opened = 0;
    var tc = document.createElement('canvas'); tc.width = 16; tc.height = 12;
    var tctx = tc.getContext('2d');
    function open(){ opened = Date.now(); dec.src = m.url + '?t=' + Date.now(); }
    dec.onerror = function(){ if (!dead) { dead = true; clear(); fail('img error'); } };
    open();
    var iv = setInterval(function(){
      if (dead || !dec.naturalWidth) return;
      var s = 0, d, i;
      try { tctx.drawImage(dec, 0, 0, 16, 12); d = tctx.getImageData(0, 0, 16, 12).data; for (i = 0; i < d.length; i += 4) s += d[i] + d[i+1]*3 + d[i+2]*7; }
      catch(e){ s = sum + 1; }   // can't read pixels: count every tick as a frame
      if (s !== sum) { sum = s; frame(dec, dec.naturalWidth, dec.naturalHeight); }
      if (Date.now() - opened > 10000) open();
    }, 30);   // check often: a slow check caps the fps (120 ms => max 8 fps)
    function clear(){ clearInterval(iv); dec.onerror = null; dec.removeAttribute('src'); }
    return { stop: function(){ dead = true; clear(); } };
  }

  // Photo mode is slow: every 20 s, between two photos, check briefly whether video works now.
  // cb(true) => upTarget holds the video method that gave a frame.
  var upTarget = null;
  function testVideo(cb){
    var cands = list.filter(function(x){ return x.kind !== 'photo' && !x.skip; });
    if (!cands.length) { cb(false); return null; }
    var v = cands[upIdx++ % cands.length], done = false, h = null;
    lastFrameAt = Date.now();                       // keep the stall watchdog quiet during the test
    log('checking video again: ' + v.id);
    var to = setTimeout(function(){ fin(false); }, 3000);
    function fin(ok){
      if (done) return; done = true; clearTimeout(to);
      if (h) h.stop();
      upTarget = ok ? v : null;
      log(ok ? 'video works again' : 'video still not working');
      setTimeout(function(){ cb(ok); }, 300);    // let the camera close that connection
    }
    h = IMPL[v.kind](v, function(){ fin(true); }, function(){ fin(false); });
    if (done) h.stop();
    return { stop: function(){ done = true; clearTimeout(to); if (h) h.stop(); } };
  }

  // One photo after another, as fast as the camera answers.
  // The camera serves one connection at a time, so the next photo is requested as soon as the
  // current one has arrived, and is decoded (scaled to 800 px wide, off the main thread) meanwhile.
  var upTries = 0;
  function photos(m, frame, fail){
    var dead = false, got = false, lastUp = Date.now(), test = null, ctl = null, to = null, n = null;
    var useFetch = typeof window.createImageBitmap === 'function';
    function next(){
      if (dead) return;
      // video doesn't work on this camera's stock firmware: check again only twice per session
      if (got && !STOCK && upTries < 2 && Date.now() - lastUp > 20000) {
        lastUp = Date.now(); upTries++;
        test = testVideo(function(ok){ test = null; if (dead) return; if (ok) { dead = true; fail('upgrade'); } else next(); });
        return;
      }
      if (useFetch) viaFetch(); else viaImg();
    }
    function show(pic, w, h){ if (dead) return; got = true; frame(pic, w, h); }
    function viaFetch(){
      var t1 = Date.now();
      ctl = window.AbortController ? new AbortController() : null;
      // a slow photo is still a photo: give it time (aborting it would only waste what already arrived)
      to = setTimeout(function(){ try { ctl && ctl.abort(); } catch(e){} }, got ? T.photo : T.firstPhoto);
      fetch(m.url + '?t=' + Date.now(), ctl ? {signal: ctl.signal, cache: 'no-store'} : {cache: 'no-store'})
        .then(function(r){ if (!r.ok) throw new Error('http ' + r.status); return r.blob(); })
        .then(function(b){
          clearTimeout(to); if (dead) return;
          var dt = Date.now() - t1; pst.n++; pst.sum += dt; if (dt > pst.max) pst.max = dt;
          setTimeout(next, 30);     // short gap: the camera must close this connection before it accepts the next
          window.createImageBitmap(b, {resizeWidth: 800, resizeQuality: 'low'})
            .catch(function(){ return window.createImageBitmap(b); })
            .then(function(bmp){ show(bmp, bmp.width, bmp.height); if (bmp.close) bmp.close(); }, function(){ log('photo decode failed'); });
        })
        .catch(function(e){ clearTimeout(to); bad(e && e.message ? e.message : 'photo failed'); });
    }
    function viaImg(){
      n = new Image();
      to = setTimeout(function(){ bad('photo timeout'); }, got ? T.photo : T.firstPhoto);
      n.onload = function(){ clearTimeout(to); var im = n; setTimeout(next, 30); show(im, im.naturalWidth, im.naturalHeight); };
      n.onerror = function(){ bad('photo error'); };
      n.src = m.url + '?t=' + Date.now();
    }
    function bad(reason){
      if (dead) return; clearTimeout(to);
      if (n) { n.onload = n.onerror = null; n.src = ''; n = null; }
      if (!got) { dead = true; fail(reason); return; }
      pst.retry++;
      setTimeout(next, 150);    // camera busy or one photo lost: just ask again (only the watchdog decides "disconnected")
    }
    next();
    return { stop: function(){
      dead = true; clearTimeout(to); if (test) test.stop();
      try { ctl && ctl.abort(); } catch(e){}
      if (n) { n.onload = n.onerror = null; n.src = ''; }
    } };
  }
  var IMPL = { fetch: fetchVideo, img: imgVideo, photo: photos };

  // ---- Runner: try methods in order; on a stall retry the working one first ----
  function runFrom(idx, tried){
    if (stopped) return;
    if (mode === 'reconnect' && Date.now() - reconnStart > T.giveUp) { log('gave up reconnecting'); post('error', 'lost'); stopAll(); return; }
    if (tried >= list.length) {
      if (mode === 'start') {
        if (++round < 2) { log('round ' + (round + 1)); setTimeout(function(){ runFrom(0, 0); }, 1500); }
        else { log('no method gave frames'); post('error', 'novideo'); stopAll(); }
      } else setTimeout(function(){ runFrom(idx, 0); }, 500);
      return;
    }
    var i = idx % list.length, m = list[i];
    if (m.skip && mode === 'start') { runFrom(i + 1, tried + 1); return; }
    var limit = m.kind === 'photo' ? T.firstPhoto : T.firstVideo;
    if (mode === 'start') {
      post('phase', JSON.stringify({
        i: 1 + round * list.length + tried, n: 1 + 2 * list.length, ms: limit,
        label: (m.kind === 'photo' ? 'Trying photo mode' : 'Starting video') + ' (' + (tried + 1) + ' of ' + list.length + ')' + (round ? ' - attempt 2 of 2' : '')
      }));
    }
    log('try ' + m.id);
    var got = false, ended = false;
    var timer = setTimeout(function(){ if (!got) end('no frame in ' + limit / 1000 + 's'); }, limit);
    function end(reason){
      if (ended) return; ended = true; clearTimeout(timer);
      if (cur && cur.h) cur.h.stop(); cur = null;
      log(m.id + ': ' + reason);
      if (reason === 'resize') { sendSize(CODES[sizeIdx], function(){ runFrom(i, tried); }); return; }
      if (reason === 'upgrade' && upTarget) { var j = list.indexOf(upTarget); upTarget = null; runFrom(j, 0); return; }
      if (got) {                                    // it was working: reconnect, same method first
        if (live) { live = false; post('reconnecting'); }
        mode = 'reconnect'; if (!reconnStart) reconnStart = Date.now();
        setTimeout(function(){ runFrom(i, 0); }, 500);
        return;
      }
      if (m.kind === 'fetch' && /no frame/.test(reason)) {
        list.forEach(function(x){ if (x.kind === 'img' && x.url === m.url) x.skip = true; });  // connected but silent: <img> won't do better
      }
      runFrom(i + 1, tried + 1);
    }
    cur = { end: end, h: null };
    cur.h = IMPL[m.kind](m, function(pic, w, h){
      if (ended) return;
      if (!got) { got = true; clearTimeout(timer); }
      onFrame(pic, w, h, m);
    }, end);
  }

  // Watchdog: silence while live => reconnect.
  setInterval(function(){
    if (stopped || !live) return;
    var quiet = Date.now() - lastFrameAt, photo = liveKind === 'photo', lim = photo ? T.stallPhoto : T.stall;
    if (photo && quiet > T.slow && !slowShown) { slowShown = true; post('slow'); }
    if (quiet > lim && cur) { slowShown = false; cur.end('stalled ' + lim / 1000 + 's'); }
  }, 500);

  // ---- Probe the camera, then build the list of methods ----
  function discover(html){
    var paths = [], re = /["'\`]((?:https?:\\/\\/[^"'\`\\/]+)?\\/?[\\w\\-\\/\\.]*(?:still|snap|capture|photo|jpg|jpeg)[\\w\\-\\/\\.\\?=&]*)["'\`]/gi, m;
    while ((m = re.exec(html || ''))) {
      var p = m[1].replace(/^https?:\\/\\/[^\\/]+/, '');
      if (p.charAt(0) !== '/') p = '/' + p;
      p = p.split('?')[0];
      if (p.length > 1 && paths.indexOf(p) < 0 && !/\\.(js|css|html)$/.test(p)) paths.push(p);
    }
    ['/capture', '/jpg', '/still', '/snapshot'].forEach(function(p){ if (paths.indexOf(p) < 0) paths.push(p); });
    return paths.slice(0, 4);
  }
  // The camera's stock firmware (its page has "Start Stream") sends a broken video stream that
  // phones can't read, and an open /stream blocks the camera (it serves one connection at a time):
  // with it, use photos only. Other firmware gets the full list (video first).
  var STOCK = false, HAS_SIZE = false;
  function build(html){
    var s1 = BASE + '/stream', s2 = 'http://' + HOST + ':81/stream';
    STOCK = /Start Stream/i.test(html || '') && /framesize/i.test(html || '');
    HAS_SIZE = /framesize/i.test(html || '');
    if (STOCK) log('stock camera firmware: photo mode only');
    var vids = STOCK ? [] : [
      {kind: 'fetch', url: s1}, {kind: 'img', url: s1},
      {kind: 'fetch', url: s2}, {kind: 'img', url: s2}
    ];
    // stock firmware has only /capture: other photo paths would just waste seconds on every reconnect
    var L = vids.concat((STOCK ? ['/capture'] : discover(html)).map(function(p){ return {kind: 'photo', url: BASE + p}; }));
    L.forEach(function(x){ x.id = x.kind + ' ' + x.url; });
    // the remembered method goes first, but a remembered PHOTO method must never push video aside
    // (e.g. saved from the old camera software before the camera was reflashed)
    if (PREF && (STOCK || !/^photo /.test(PREF))) {
      var k = -1; L.forEach(function(x, j){ if (x.id === PREF) k = j; });
      if (k > 0) L.unshift(L.splice(k, 1)[0]);
    }
    return L;
  }
  // Keeps checking for T.probeFor: right after start the phone may still be joining / routing to
  // the camera Wi-Fi, which used to end in "not connected" although the camera answered a moment later.
  var probeStart = 0, probeWaitShown = false;
  function probe(){
    if (!probeStart) { probeStart = Date.now(); post('phase', JSON.stringify({i: 0, n: 9, ms: T.probe, label: 'Checking camera connection'})); }
    log('probe ' + BASE + '/');
    fetchT(BASE + '/', T.probe).then(function(r){ return r.text(); }).then(function(html){
      if (stopped) return;
      log('camera answered');
      list = build(html);
      if (TEST) { runTest(); return; }
      if (!CODES.length || STOCK || !HAS_SIZE) { runFrom(0, 0); return; }   // no size command on this camera: don't ask
      // Ask for a smaller picture before any stream is open (the camera serves one connection).
      // The first frame's width then shows whether the camera really changed size.
      sizeState = 'checking';
      post('phase', JSON.stringify({i: 0, n: 9, ms: 2500, label: 'Setting picture size'}));
      sendSize(CODES[0], function(){ runFrom(0, 0); });
    }, function(e){
      if (stopped) return;
      log('probe failed: ' + (e && e.message ? e.message : e));
      if (!probeWaitShown) {
        probeWaitShown = true;
        post('phase', JSON.stringify({i: 0, n: 9, ms: T.probeFor, label: 'Waiting for camera Wi-Fi...'}));
      }
      if (Date.now() - probeStart + 1500 < T.probeFor) setTimeout(probe, 1500);
      else post('error', 'unreachable');
    });
  }

  function stopAll(){
    stopped = true;
    if (cur && cur.h) cur.h.stop();
    cur = null;
    dec.onerror = null; dec.removeAttribute('src');
    try { window.stop(); } catch(e){}
  }
  window.addEventListener('pagehide', stopAll);

  ${TEST_JS}
  if (ACTIVE) probe();
</script></body></html>`;
}
