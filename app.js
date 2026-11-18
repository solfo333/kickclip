'use strict';
/* KickClip – registratore di clip e analisi dei tiri (tutto sul dispositivo) */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => performance.now() / 1000;
const fmt0 = n => Math.round(n).toLocaleString('it-IT');
const fmt1 = n => n.toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmt2 = n => n.toLocaleString('it-IT', { maximumFractionDigits: 2 });

/* ============================ Impostazioni ============================ */
const DEFAULTS = { pre: 4, post: 4, fps: 30, mode: 'audio', sens: 6, facing: 'environment', quality: 'std', maxClips: 40, calib: null };
const QUALITY = { low: 0.5, std: 0.65, high: 0.82 };
let settings = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('kickclip.settings') || '{}') }; }
  catch (e) { return { ...DEFAULTS }; }
})();
const saveSettings = () => { try { localStorage.setItem('kickclip.settings', JSON.stringify(settings)); } catch (e) { /* ignora */ } };

function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

/* ============================ Tab ============================ */
$$('nav button').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });
function showTab(name) {
  $$('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
  $$('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'clips') renderClips();
  if (name === 'stats') renderStats();
  if (name === 'settings') renderSettings();
}

/* ============================ Database (IndexedDB) ============================ */
const DB = (() => {
  let db;
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open('kickclip', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('meta', { keyPath: 'id' });
      r.result.createObjectStore('frames');
    };
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
  const tx = (stores, mode, fn) => new Promise((res, rej) => {
    const t = db.transaction(stores, mode);
    let out;
    try { out = fn(t); } catch (e) { rej(e); return; }
    t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
  return {
    open,
    putClip: (meta, frames) => tx(['meta', 'frames'], 'readwrite', t => {
      t.objectStore('meta').put(meta);
      t.objectStore('frames').put(frames, meta.id);
    }),
    putMeta: meta => tx('meta', 'readwrite', t => t.objectStore('meta').put(meta)),
    allMeta: () => tx('meta', 'readonly', t => t.objectStore('meta').getAll()),
    frames: id => tx('frames', 'readonly', t => t.objectStore('frames').get(id)),
    del: id => tx(['meta', 'frames'], 'readwrite', t => {
      t.objectStore('meta').delete(id);
      t.objectStore('frames').delete(id);
    }),
    clear: () => tx(['meta', 'frames'], 'readwrite', t => {
      t.objectStore('meta').clear();
      t.objectStore('frames').clear();
    })
  };
})();

/* ============================ Analisi (Worker con fallback) ============================ */
let worker = null, workerOk = true, seq = 0;
const pending = new Map();
function runAnalysis(opts) {
  return new Promise(resolve => {
    const local = () => {
      try { resolve(KickAnalysis.analyzeClip(opts)); }
      catch (e) { resolve({ ok: false, reason: 'errore analisi' }); }
    };
    if (!workerOk) { local(); return; }
    try {
      if (!worker) {
        worker = new Worker('worker.js');
        worker.onmessage = ev => {
          const r = pending.get(ev.data.id);
          if (r) { pending.delete(ev.data.id); r(ev.data.result); }
        };
        worker.onerror = () => {
          workerOk = false; worker = null;
          pending.forEach(r => r({ ok: false, reason: 'errore analisi' }));
          pending.clear();
        };
      }
      const id = ++seq;
      pending.set(id, resolve);
      worker.postMessage({ id, opts });
    } catch (e) { workerOk = false; local(); }
  });
}

/* ============================ Scala / metriche ============================ */
function mppFromCalib(c, aw, ah) {
  if (!c) return null;
  const d = Math.hypot((c.x2 - c.x1) * aw, (c.y2 - c.y1) * ah);
  return d > 1 ? c.meters / d : null;
}
const clipMpp = m => mppFromCalib(m.calib, m.aw, m.ah);

function metrics(meta) {
  const a = meta.analysis;
  if (!a || !a.ok) return null;
  if (a.view === 'dietro') return { behind: true, angle: a.angleDeg, dir: a.direction, conf: a.confidence, n: a.n };
  const mpp = clipMpp(meta);
  const out = { speedPx: a.speedPx, angle: a.angleDeg, dir: a.direction, conf: a.confidence, n: a.n };
  if (mpp) {
    out.kmh = a.speedPx * mpp * 3.6;
    out.height = a.heightPx * mpp;
    out.path = a.pathPx * mpp;
  }
  return out;
}

function updateCalibState() {
  const c = settings.calib;
  const txt = c ? `Scala impostata: ${fmt2(c.meters)} m` : 'Scala non impostata: senza non posso dare i km/h (puoi impostarla anche dopo, su ogni clip).';
  $('#calibState').textContent = txt;
  $('#calibState2').textContent = c ? `${fmt2(c.meters)} m impostati` : 'Non impostata';
}

/* ============================ Cattura ============================ */
const cap = {
  running: false, stream: null, video: $('#cam'),
  W: 0, H: 0, AW: 320, AH: 180,
  canvas: document.createElement('canvas'), ctx: null,
  small: document.createElement('canvas'), sctx: null,
  buf: [], inflight: 0, prevGray: null, motion: [],
  lastFrameT: 0, lastShotT: -99, pendingShots: 0, sessionShots: 0, lastMetaId: null,
  fpsCount: 0, fpsT: 0, fps: 0, mtOff: undefined, wl: null, uiTimer: 0
};

function frameTime(n, m) {
  if (m && typeof m.captureTime === 'number') return m.captureTime / 1000;
  if (m && typeof m.mediaTime === 'number') {
    if (cap.mtOff === undefined) cap.mtOff = n / 1000 - m.mediaTime;
    return m.mediaTime + cap.mtOff;
  }
  return n / 1000;
}

async function startCapture() {
  if (cap.running) return true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Camera non disponibile: apri l\'app da un indirizzo https');
    return false;
  }
  const video = { facingMode: settings.facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: settings.fps } };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (e) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video });
      toast('Microfono non disponibile: usa «Salva ultimi secondi»');
    } catch (e2) {
      toast('Permesso alla camera negato');
      return false;
    }
  }
  cap.stream = stream;
  cap.video.srcObject = stream;
  try { await cap.video.play(); } catch (e) { /* autoplay già attivo */ }
  if (!cap.video.videoWidth) await new Promise(r => cap.video.addEventListener('loadedmetadata', r, { once: true }));
  const vw = cap.video.videoWidth, vh = cap.video.videoHeight;
  cap.W = Math.min(960, vw);
  cap.H = Math.round(cap.W * vh / vw);
  cap.AW = 320;
  cap.AH = Math.round(cap.AW * vh / vw);
  cap.canvas.width = cap.W; cap.canvas.height = cap.H;
  cap.small.width = cap.AW; cap.small.height = cap.AH;
  cap.ctx = cap.canvas.getContext('2d');
  cap.sctx = cap.small.getContext('2d', { willReadFrequently: true });
  cap.buf = []; cap.motion = []; cap.prevGray = null; cap.inflight = 0;
  cap.lastFrameT = 0; cap.mtOff = undefined; cap.fpsCount = 0; cap.fpsT = now(); cap.sessionShots = 0;
  cap.running = true;
  setupAudio(stream);
  scheduleFrame();
  cap.uiTimer = setInterval(uiTick, 500);
  lockScreen();
  setRunningUI(true);
  return true;
}

function stopCapture() {
  cap.running = false;
  clearInterval(cap.uiTimer);
  clearInterval(audio.timer);
  if (audio.ctx) { try { audio.ctx.close(); } catch (e) { /* ignora */ } }
  audio.an = null; audio.ctx = null;
  if (cap.stream) cap.stream.getTracks().forEach(t => t.stop());
  cap.stream = null;
  cap.video.srcObject = null;
  if (cap.wl) { try { cap.wl.release(); } catch (e) { /* ignora */ } cap.wl = null; }
  setRunningUI(false);
}

async function lockScreen() {
  try { if (navigator.wakeLock) cap.wl = await navigator.wakeLock.request('screen'); } catch (e) { /* ignora */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && cap.running) {
    lockScreen();
    if (cap.video.paused) cap.video.play().catch(() => {});
  }
});

function scheduleFrame() {
  const v = cap.video;
  if ('requestVideoFrameCallback' in v) {
    v.requestVideoFrameCallback((n, m) => { onFrame(frameTime(n, m)); if (cap.running) scheduleFrame(); });
  } else {
    requestAnimationFrame(n => { onFrame(n / 1000); if (cap.running) scheduleFrame(); });
  }
}

function onFrame(t) {
  if (!cap.running) return;
  if (t - cap.lastFrameT < (1 / settings.fps) * 0.8) return;
  cap.lastFrameT = t;
  cap.fpsCount++;
  const v = cap.video, AW = cap.AW, AH = cap.AH, n = AW * AH;

  // frame piccolo in scala di grigi (per rilevamento e analisi)
  cap.sctx.drawImage(v, 0, 0, AW, AH);
  const px = cap.sctx.getImageData(0, 0, AW, AH).data;
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;

  // energia di movimento (usata dalla modalità «audio + movimento»)
  if (cap.prevGray) {
    let c = 0;
    const p = cap.prevGray;
    for (let i = 0; i < n; i += 2) if (Math.abs(g[i] - p[i]) > 25) c++;
    cap.motion.push({ t, v: c / (n / 2) });
  }
  cap.prevGray = g;

  // frame JPEG per la clip
  const entry = { t, g, blob: null };
  cap.buf.push(entry);
  if (cap.inflight < 4) {
    cap.ctx.drawImage(v, 0, 0, cap.W, cap.H);
    cap.inflight++;
    cap.canvas.toBlob(b => { entry.blob = b; cap.inflight--; }, 'image/jpeg', QUALITY[settings.quality] || 0.65);
  }

  const keep = settings.pre + settings.post + 3;
  while (cap.buf.length && cap.buf[0].t < t - keep) cap.buf.shift();
  while (cap.motion.length && cap.motion[0].t < t - keep) cap.motion.shift();
}

function uiTick() {
  const t = now();
  cap.fps = cap.fpsCount / Math.max(0.2, t - cap.fpsT);
  cap.fpsCount = 0; cap.fpsT = t;
  $('#chipFps').textContent = `${Math.round(cap.fps)} fps`;
  const st = $('#chipState');
  st.textContent = cap.pendingShots ? '● Salvo il tiro…' : '● In ascolto';
}

function setRunningUI(on) {
  $('#camwrap').classList.toggle('live', on);
  $('#chipState').hidden = !on;
  $('#chipFps').hidden = !on;
  $('#meterWrap').hidden = !on;
  $('#meterLbl').hidden = !on;
  $('#btnManual').disabled = !on;
  const b = $('#btnStart');
  b.textContent = on ? 'Ferma registrazione' : 'Avvia registrazione';
  b.classList.toggle('primary', !on);
  b.classList.toggle('stop', on);
}

function updateManualLabel() {
  $('#btnManual').textContent = `Salva ultimi ${settings.pre + settings.post} s`;
}

/* ============================ Audio: rilevamento dell'impatto ============================ */
const audio = { ctx: null, an: null, buf: null, base: 0.01, last: -99, timer: 0, tick: 0 };

function setupAudio(stream) {
  audio.an = null; audio.ctx = null;
  if (!stream.getAudioTracks().length) return false;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    audio.ctx = new AC();
    const src = audio.ctx.createMediaStreamSource(stream);
    audio.an = audio.ctx.createAnalyser();
    audio.an.fftSize = 1024;
    audio.an.smoothingTimeConstant = 0;
    src.connect(audio.an);
    audio.buf = new Float32Array(audio.an.fftSize);
    audio.base = 0.01;
    audio.last = -99;
    audio.timer = setInterval(audioTick, 12);
    if (audio.ctx.state === 'suspended') audio.ctx.resume();
    return true;
  } catch (e) {
    console.warn('audio non disponibile', e);
    return false;
  }
}

function audioTick() {
  if (!audio.an || !cap.running) return;
  audio.an.getFloatTimeDomainData(audio.buf);
  const b = audio.buf;
  let peak = 0, sum = 0;
  for (let i = 0; i < b.length; i++) {
    const v = Math.abs(b[i]);
    if (v > peak) peak = v;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / b.length);
  const t = now();
  // soglia relativa al rumore di fondo (vento, voci): più alta la sensibilità, più bassa la soglia
  const K = 16 - settings.sens * 1.3;
  const thr = Math.max(0.05, audio.base * K);
  const crest = peak / (rms + 1e-5); // un colpo secco ha un picco molto più alto della media
  const fire = peak > thr && crest > 3 && t - audio.last > 0.3;
  if (!fire) audio.base = audio.base * 0.985 + rms * 0.015;
  if (fire) {
    audio.last = t;
    if (settings.mode !== 'manual') registerShot(t, settings.mode === 'both' ? 'audio+mov' : 'audio');
  }
  if ((++audio.tick & 1) === 0) {
    $('#lvl').style.width = Math.min(100, peak * 100) + '%';
    $('#lvlThr').style.left = Math.min(98, thr * 100) + '%';
  }
}

/* ============================ Tiri e clip ============================ */
function registerShot(T, source, manual) {
  if (!cap.running) return;
  if (!manual && T - cap.lastShotT < 1.5) return;
  if (!manual) cap.lastShotT = T;
  const dims = { W: cap.W, H: cap.H, AW: cap.AW, AH: cap.AH };
  cap.pendingShots++;
  const chip = $('#chipState');
  chip.classList.add('hit');
  setTimeout(() => chip.classList.remove('hit'), 700);
  if (navigator.vibrate) navigator.vibrate(40);
  const delay = manual ? 250 : (settings.post + 0.6) * 1000;
  setTimeout(() => {
    finalizeShot(T, source, manual, dims)
      .catch(e => { console.error(e); toast('Errore nel salvataggio della clip'); })
      .finally(() => { cap.pendingShots--; });
  }, delay);
}

async function finalizeShot(T, source, manual, dims) {
  const from = T - settings.pre, to = T + settings.post;
  const sel = cap.buf.filter(e => e.blob && e.t >= from && e.t <= to);
  if (sel.length < 8) { if (manual) toast('Registrazione ancora troppo corta'); return; }

  if (source === 'audio+mov') {
    const mv = cap.motion.filter(m => m.t >= T - 0.3 && m.t <= T + 0.5).reduce((a, m) => Math.max(a, m.v), 0);
    if (mv < 0.004) return; // rumore senza movimento: scartato
  }

  const times = sel.map(e => e.t - T);
  const mpp = mppFromCalib(settings.calib, dims.AW, dims.AH);
  const analysis = await runAnalysis({
    frames: sel.map(e => e.g), times, w: dims.AW, h: dims.AH,
    impactTime: manual ? null : 0, mpp
  });

  let thumbIdx = 0;
  if (analysis.ok) thumbIdx = analysis.launchIndex;
  else { let best = 1e9; times.forEach((x, i) => { if (Math.abs(x) < best) { best = Math.abs(x); thumbIdx = i; } }); }

  const meta = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    ts: Date.now(), w: dims.W, h: dims.H, aw: dims.AW, ah: dims.AH,
    times, source, analysis, calib: settings.calib, fav: false,
    thumb: sel[thumbIdx].blob
  };
  try {
    await DB.putClip(meta, sel.map(e => e.blob));
  } catch (e) {
    console.error(e);
    toast('Spazio insufficiente: elimina qualche clip');
    return;
  }
  cap.sessionShots++;
  cap.lastMetaId = meta.id;
  showLast(meta);
  await enforceLimit();
}

function showLast(meta) {
  const x = metrics(meta);
  $('#lastCard').hidden = false;
  $('#howto').hidden = true;
  $('#sessionCount').textContent = cap.sessionShots;
  if (!x) {
    $('#lastSpeed').innerHTML = '–';
    $('#lastMeta').textContent = 'Palla non rilevata, ma la clip è salvata.';
    toast('Clip salvata (palla non rilevata)');
  } else if (x.kmh) {
    $('#lastSpeed').innerHTML = `${fmt0(x.kmh)}<small>km/h</small>`;
    $('#lastMeta').textContent = `Angolo ${fmt0(x.angle)}° · affidabilità ${x.conf}`;
    toast(`Tiro rilevato: ${fmt0(x.kmh)} km/h`);
  } else {
    $('#lastSpeed').innerHTML = `${fmt0(x.speedPx)}<small>px/s</small>`;
    $('#lastMeta').textContent = 'Imposta la scala per vedere i km/h.';
    toast('Tiro rilevato: imposta la scala per i km/h');
  }
}

async function enforceLimit() {
  const metas = (await DB.allMeta()).filter(m => !m.fav).sort((a, b) => a.ts - b.ts);
  const extra = metas.length - settings.maxClips;
  for (let i = 0; i < extra; i++) await DB.del(metas[i].id);
}

/* ============================ Elenco clip ============================ */
let thumbUrls = [];
async function renderClips() {
  const list = (await DB.allMeta()).sort((a, b) => b.ts - a.ts);
  thumbUrls.forEach(u => URL.revokeObjectURL(u));
  thumbUrls = [];
  const grid = $('#clipGrid');
  grid.innerHTML = '';
  $('#clipsEmpty').hidden = list.length > 0;
  for (const m of list) {
    const x = metrics(m);
    const url = URL.createObjectURL(m.thumb);
    thumbUrls.push(url);
    const d = new Date(m.ts);
    const b = document.createElement('button');
    b.className = 'clip';
    const sp = !x ? '—' : x.behind ? `da dietro · ${x.dir}` : x.kmh ? `${fmt0(x.kmh)} km/h` : `${fmt0(x.speedPx)} px/s`;
    b.innerHTML = `<img alt="" src="${url}"><span class="sp">${sp}</span>${m.fav ? '<span class="star">★</span>' : ''}` +
      `<div class="meta">${d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} · ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}${m.source === 'manuale' ? ' · manuale' : m.source === 'video' ? ' · video' : ''}</div>`;
    b.onclick = () => openPlayer(m.id);
    grid.appendChild(b);
  }
}

/* ============================ Player ============================ */
const P = { meta: null, frames: null, idx: 0, rate: 0.5, overlay: true, playing: false, token: 0, cache: new Map(), ctx: null };

function bitmap(i) {
  let p = P.cache.get(i);
  if (!p) {
    p = createImageBitmap(P.frames[i]);
    P.cache.set(i, p);
    if (P.cache.size > 40) {
      const k = P.cache.keys().next().value;
      P.cache.get(k).then(b => b.close()).catch(() => {});
      P.cache.delete(k);
    }
  }
  return p;
}

function indexAtTime(times, t) {
  for (let i = 0; i < times.length; i++) if (times[i] >= t) return i;
  return times.length - 1;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

function drawOverlay(ctx, meta, idx) {
  const a = meta.analysis;
  if (!a || !a.ok) return;
  const sx = meta.w / meta.aw, sy = meta.h / meta.ah;
  const t = meta.times[idx];
  const pts = a.points;
  const lw = Math.max(2, meta.w / 300);
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  // traiettoria completa (tenue)
  ctx.strokeStyle = 'rgba(52,224,122,.35)'; ctx.lineWidth = lw;
  ctx.beginPath();
  pts.forEach((p, k) => (k ? ctx.lineTo(p.x * sx, p.y * sy) : ctx.moveTo(p.x * sx, p.y * sy)));
  ctx.stroke();
  // parte già percorsa
  ctx.strokeStyle = '#34e07a'; ctx.lineWidth = lw * 1.6;
  ctx.beginPath();
  let n = 0;
  for (const p of pts) {
    if (p.t > t + 1e-6) break;
    if (n) ctx.lineTo(p.x * sx, p.y * sy); else ctx.moveTo(p.x * sx, p.y * sy);
    n++;
  }
  if (n > 1) ctx.stroke();
  // traiettoria prevista (tratteggiata): dove il pallone dovrebbe andare quando non lo vedo più
  if (a.pred && a.pred.length && n === pts.length) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,210,74,.9)'; ctx.lineWidth = lw * 1.3; ctx.setLineDash([lw * 2.5, lw * 2.5]);
    ctx.beginPath(); const l = pts[pts.length - 1]; ctx.moveTo(l.x * sx, l.y * sy);
    let shown = 0;
    for (const p of a.pred) { if (p.t > t + 1e-6) break; ctx.lineTo(p.x * sx, p.y * sy); shown++; }
    if (shown) ctx.stroke();
    ctx.restore();
  }
  // pallone
  const cur = n ? pts[n - 1] : null;
  if (cur && t - cur.t < 0.12) {
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#34e07a'; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.arc(cur.x * sx, cur.y * sy, Math.max(6, meta.w / 110), 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  }
  // scritta con la velocità, dal momento del tiro
  if (t >= pts[0].t - 0.05) {
    const m = metrics(meta);
    const big = m.behind ? `verso ${m.dir}` : m.kmh ? `${fmt0(m.kmh)} km/h` : `${fmt0(m.speedPx)} px/s`;
    const small = m.behind ? `tiro da dietro · ${fmt0(Math.abs(m.angle))}° nell'immagine` : m.kmh ? `${fmt0(m.angle)}° · max ${fmt1(m.height)} m` : 'imposta la scala per i km/h';
    const fs = Math.round(meta.w / 14), fs2 = Math.round(meta.w / 32), pad = fs2;
    ctx.font = `800 ${fs}px system-ui, sans-serif`;
    const w1 = ctx.measureText(big).width;
    ctx.font = `600 ${fs2}px system-ui, sans-serif`;
    const w2 = ctx.measureText(small).width;
    const bw = Math.max(w1, w2) + pad * 2, bh = fs + fs2 + pad * 2.2;
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    roundRect(ctx, pad, pad, bw, bh, pad); ctx.fill();
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#fff'; ctx.font = `800 ${fs}px system-ui, sans-serif`;
    ctx.fillText(big, pad * 2, pad * 1.4);
    ctx.fillStyle = '#34e07a'; ctx.font = `600 ${fs2}px system-ui, sans-serif`;
    ctx.fillText(small, pad * 2, pad * 1.4 + fs * 1.05);
  }
  ctx.restore();
}

async function show(i) {
  const bmp = await bitmap(i);
  P.idx = i;
  P.ctx.drawImage(bmp, 0, 0);
  if (P.overlay) drawOverlay(P.ctx, P.meta, i);
  $('#pSlider').value = i;
  const tt = P.meta.times[i];
  const free = isFree(P.meta);
  $('#pTime').textContent = (free ? '' : (tt >= 0 ? '+' : '')) + tt.toFixed(2).replace('.', ',') + ' s' + (free ? '' : ' dall\'impatto');
  for (let k = 1; k <= 6; k++) if (i + k < P.frames.length) bitmap(i + k).catch(() => {});
}

function updatePlayBtn() { $('#pPlay').textContent = P.playing ? '❚❚' : '▶'; }
function pause() { P.token++; P.playing = false; updatePlayBtn(); }
function play() {
  if (!P.meta) return;
  const token = ++P.token;
  P.playing = true; updatePlayBtn();
  const times = P.meta.times, last = times.length - 1;
  if (P.idx >= last) P.idx = 0;
  const t0 = times[P.idx], w0 = performance.now();
  const step = async () => {
    if (token !== P.token) return;
    const target = t0 + (performance.now() - w0) / 1000 * P.rate;
    if (target >= times[last]) {
      await show(last);
      if (token === P.token) { P.playing = false; updatePlayBtn(); }
      return;
    }
    let i = P.idx;
    while (i < last && times[i + 1] <= target) i++;
    if (i !== P.idx) await show(i);
    if (token === P.token) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

async function openPlayer(id) {
  const meta = (await DB.allMeta()).find(m => m.id === id);
  if (!meta) return;
  const frames = await DB.frames(id);
  if (!frames || !frames.length) { toast('Clip non trovata'); return; }
  pause();
  P.cache.forEach(p => p.then(b => b.close()).catch(() => {}));
  P.cache.clear();
  P.meta = meta; P.frames = frames; P.rate = 0.5; P.overlay = true;
  const cv = $('#pcanvas');
  cv.width = meta.w; cv.height = meta.h;
  P.ctx = cv.getContext('2d');
  $('#pSlider').max = frames.length - 1;
  $$('#pRates button[data-rate]').forEach(b => b.classList.toggle('on', +b.dataset.rate === P.rate));
  $('#pOverlay').classList.add('on');
  updateFavBtn();
  $('#player').classList.add('open');
  const a = meta.analysis;
  P.idx = a && a.ok ? indexAtTime(meta.times, a.points[0].t - 0.4) : 0;
  await show(P.idx);
  renderInfo();
  play();
}

function closePlayer() {
  pause();
  $('#player').classList.remove('open');
  if ($('#tab-clips').classList.contains('active')) renderClips();
  if ($('#tab-stats').classList.contains('active')) renderStats();
}

function updateFavBtn() { $('#pFav').textContent = P.meta && P.meta.fav ? '★ Preferito' : '☆ Preferito'; }

function renderInfo() {
  const m = P.meta, x = metrics(m), el = $('#pInfo');
  const when = new Date(m.ts).toLocaleString('it-IT', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const foot = `<p class="note" style="margin-top:10px">${when} · ${m.source === 'video' ? 'video caricato' : m.source === 'manuale' ? 'salvataggio manuale' : 'rilevato dall\'audio'}</p>`;
  if (!x) {
    const why = m.analysis && m.analysis.reason ? m.analysis.reason : 'palla non rilevata';
    el.innerHTML = `<div class="kv"><b>Analisi</b><span>${why}</span></div>` +
      `<p class="note">Consigli: telefono fermo su un treppiede, di lato al tiro, sfondo uniforme, buona luce e, se puoi, 60 fps. Tocca «Imposta scala» per aiutare il rilevamento.</p>` + foot;
    return;
  }
  if (x.behind) {
    el.innerHTML = `<div class="bigspeed" style="font-size:34px">${x.dir}<small>vista da dietro</small></div>` +
      `<div class="kv">Angolo nell'immagine<span>${x.dir === 'dritto' ? 'dritto' : fmt0(Math.abs(x.angle)) + '° a ' + x.dir}</span></div>` +
      `<div class="kv">Punti tracciati<span>${x.n}</span></div>` +
      `<div class="kv">Affidabilità<span class="badge ${x.conf}">${x.conf}</span></div>` +
      `<p class="note">Da dietro non ti do i km/h: dipendono dallo zoom e dalla distanza e per ora non sono affidabili. Il percorso verde è dove ho visto davvero il pallone; la linea gialla tratteggiata è solo una previsione (continuazione più probabile) e diventa meno sicura man mano che si allontana. L'angolo è quello visto nella ripresa, non rispetto alla porta.</p>` + foot;
    return;
  }
  const head = x.kmh
    ? `<div class="bigspeed">${fmt0(x.kmh)}<small>km/h</small></div>`
    : `<div class="bigspeed">–<small>km/h</small></div><p class="note">Tocca «Imposta scala» e indica una distanza nota: te li calcolo subito. Per ora: ${fmt0(x.speedPx)} px/s.</p>`;
  let rows = `<div class="kv">Angolo di partenza<span>${fmt0(x.angle)}°</span></div>`;
  if (x.kmh) {
    rows += `<div class="kv">Altezza massima tracciata<span>${fmt1(x.height)} m</span></div>` +
            `<div class="kv">Percorso tracciato<span>${fmt1(x.path)} m</span></div>`;
  }
  rows += `<div class="kv">Direzione<span>verso ${x.dir}</span></div>` +
          `<div class="kv">Affidabilità<span class="badge ${x.conf}">${x.conf}</span></div>`;
  if (x.conf === 'bassa') rows += '<p class="note">Il tracciamento è incerto: controlla che la linea verde segua davvero il pallone.</p>';
  el.innerHTML = head + rows + foot;
}

$('#pClose').onclick = closePlayer;
$('#pPlay').onclick = () => { if (P.playing) pause(); else play(); };
$('#pPrev').onclick = () => { pause(); show(Math.max(0, P.idx - 1)); };
$('#pNext').onclick = () => { pause(); show(Math.min(P.frames.length - 1, P.idx + 1)); };
$('#pSlider').oninput = e => { pause(); show(+e.target.value); };
$$('#pRates button[data-rate]').forEach(b => {
  b.onclick = () => {
    P.rate = +b.dataset.rate;
    $$('#pRates button[data-rate]').forEach(o => o.classList.toggle('on', o === b));
    if (P.playing) play();
  };
});
$('#pOverlay').onclick = () => {
  P.overlay = !P.overlay;
  $('#pOverlay').classList.toggle('on', P.overlay);
  show(P.idx);
};
$('#pFav').onclick = async () => {
  P.meta.fav = !P.meta.fav;
  await DB.putMeta(P.meta);
  updateFavBtn();
};
$('#pDelete').onclick = async () => {
  if (!confirm('Eliminare questa clip?')) return;
  const id = P.meta.id;
  closePlayer();
  await DB.del(id);
  renderClips();
};
$('#pCalib').onclick = async () => {
  pause();
  const meta = P.meta;
  const bmp = await bitmap(P.idx);
  const snap = document.createElement('canvas');
  snap.width = meta.w; snap.height = meta.h;
  snap.getContext('2d').drawImage(bmp, 0, 0);
  openCalib({
    snap, w: meta.w, h: meta.h, initial: meta.calib,
    onApply: async c => {
      meta.calib = c;
      await DB.putMeta(meta);
      renderInfo();
      show(P.idx);
      toast('Scala applicata a questa clip');
    }
  });
};

/* ---------- esportazione video con scritta e traiettoria ---------- */
async function exportClip() {
  const meta = P.meta;
  if (!meta) return;
  if (!window.MediaRecorder) { toast('Esportazione non supportata da questo browser'); return; }
  pause();
  const btn = $('#pExport'), label = btn.textContent;
  btn.disabled = true;
  try {
    const cv = document.createElement('canvas');
    cv.width = meta.w; cv.height = meta.h;
    const ctx = cv.getContext('2d');
    ctx.drawImage(await bitmap(0), 0, 0);
    const stream = cv.captureStream(30);
    const mime = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find(t => MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6e6 } : { videoBitsPerSecond: 6e6 });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise(r => { rec.onstop = r; });
    rec.start(250);
    const times = meta.times, t0 = performance.now();
    for (let i = 0; i < times.length; i++) {
      const wait = t0 + (times[i] - times[0]) * 1000 / P.rate - performance.now();
      if (wait > 0) await sleep(wait);
      ctx.drawImage(await bitmap(i), 0, 0);
      drawOverlay(ctx, meta, i);
      btn.textContent = `Esporto… ${Math.round(i / times.length * 100)}%`;
    }
    await sleep(300);
    rec.stop();
    await done;
    const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
    const file = new File([new Blob(chunks, { type })], `kickclip-${meta.id}.${type.includes('mp4') ? 'mp4' : 'webm'}`, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'KickClip' }); } catch (e) { /* annullato */ }
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file); a.download = file.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    }
  } catch (e) {
    console.error(e);
    toast('Esportazione non riuscita');
  }
  btn.disabled = false;
  btn.textContent = label;
  show(P.idx);
}
$('#pExport').onclick = exportClip;

/* ============================ Calibrazione ============================ */
function openCalib({ snap, w, h, initial, onApply }) {
  const c = $('#calCanvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const pts = initial ? [{ x: initial.x1, y: initial.y1 }, { x: initial.x2, y: initial.y2 }] : [];
  $('#calMeters').value = initial ? String(initial.meters) : '7.32';
  const redraw = () => {
    ctx.drawImage(snap, 0, 0, w, h);
    ctx.lineWidth = Math.max(3, w / 240);
    ctx.strokeStyle = '#34e07a'; ctx.fillStyle = '#34e07a';
    if (pts.length === 2) {
      ctx.beginPath(); ctx.moveTo(pts[0].x * w, pts[0].y * h); ctx.lineTo(pts[1].x * w, pts[1].y * h); ctx.stroke();
    }
    pts.forEach(p => { ctx.beginPath(); ctx.arc(p.x * w, p.y * h, Math.max(7, w / 90), 0, Math.PI * 2); ctx.fill(); });
  };
  const close = () => { $('#calib').classList.remove('open'); c.onpointerdown = null; };
  c.onpointerdown = e => {
    const r = c.getBoundingClientRect();
    if (pts.length >= 2) pts.length = 0;
    pts.push({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
    redraw();
  };
  $('#calPreset').onchange = () => { const v = $('#calPreset').value; if (v) $('#calMeters').value = v; };
  $('#calCancel').onclick = close;
  $('#calOk').onclick = () => {
    const m = parseFloat(String($('#calMeters').value).replace(',', '.'));
    if (pts.length < 2 || !(m > 0)) { toast('Tocca due punti e indica la distanza in metri'); return; }
    onApply({ x1: pts[0].x, y1: pts[0].y, x2: pts[1].x, y2: pts[1].y, meters: m });
    close();
  };
  $('#calib').classList.add('open');
  redraw();
}

async function calibrateLive() {
  if (!cap.running) { const ok = await startCapture(); if (!ok) return; await sleep(400); }
  const snap = document.createElement('canvas');
  snap.width = cap.W; snap.height = cap.H;
  snap.getContext('2d').drawImage(cap.video, 0, 0, cap.W, cap.H);
  openCalib({
    snap, w: cap.W, h: cap.H, initial: settings.calib,
    onApply: c => { settings.calib = c; saveSettings(); updateCalibState(); toast('Scala impostata'); }
  });
}

/* ============================ Statistiche ============================ */
async function renderStats() {
  const metas = (await DB.allMeta()).sort((a, b) => a.ts - b.ts);
  const box = $('#statsBody');
  if (!metas.length) {
    box.innerHTML = '<p class="empty">Ancora nessun tiro.<br>Registra qualche tiro per vedere le statistiche.</p>';
    return;
  }
  const rows = metas.map(m => ({ m, x: metrics(m) }));
  const sp = rows.filter(r => r.x && r.x.kmh);
  const speeds = sp.map(r => r.x.kmh);
  const max = speeds.length ? Math.max(...speeds) : 0;
  const avg = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
  const today = new Date().toDateString();
  const todayN = metas.filter(m => new Date(m.ts).toDateString() === today).length;
  const tracked = rows.filter(r => r.x).length;

  let html = '<div class="tiles">' +
    `<div class="tile"><b>${metas.length}</b><span>tiri registrati (${todayN} oggi)</span></div>` +
    `<div class="tile rec"><b>${speeds.length ? fmt0(max) : '–'}</b><span>km/h · record</span></div>` +
    `<div class="tile"><b>${speeds.length ? fmt0(avg) : '–'}</b><span>km/h · media</span></div>` +
    `<div class="tile"><b>${Math.round(tracked / metas.length * 100)}%</b><span>tiri con palla rilevata</span></div>` +
    '</div>';

  if (!speeds.length) {
    html += '<p class="note" style="margin-top:14px">Imposta la scala (in «Registra» o dentro una clip) per vedere velocità e andamento.</p>';
  } else {
    const last = sp.slice(-20);
    const W = 320, H = 130, bw = W / 20;
    const top = Math.max(...last.map(r => r.x.kmh));
    let bars = '';
    last.forEach((r, i) => {
      const hh = Math.max(3, r.x.kmh / top * 100);
      const isRec = r.x.kmh === max;
      bars += `<rect x="${i * bw + 2}" y="${H - 14 - hh}" width="${bw - 4}" height="${hh}" rx="3" fill="${isRec ? '#34e07a' : '#2a5a3b'}"/>`;
    });
    html += '<h2>Ultimi tiri (km/h)</h2><div class="card">' +
      `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Velocità degli ultimi tiri">${bars}` +
      `<text x="0" y="${H - 1}" fill="#8aa092" font-size="9">meno recente</text>` +
      `<text x="${W}" y="${H - 1}" fill="#8aa092" font-size="9" text-anchor="end">più recente</text></svg>` +
      `<p class="note" style="margin:6px 0 0">Il tiro più veloce è in verde: ${fmt0(max)} km/h.</p></div>`;

    const days = new Map();
    rows.slice().reverse().forEach(r => {
      const k = new Date(r.m.ts).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
      const d = days.get(k) || { n: 0, best: 0 };
      d.n++; if (r.x && r.x.kmh > d.best) d.best = r.x.kmh;
      days.set(k, d);
    });
    html += '<h2>Per giorno</h2><div class="card">';
    [...days.entries()].slice(0, 7).forEach(([k, d]) => {
      html += `<div class="day"><span>${k}</span><span>${d.n} tiri${d.best ? ' · max ' + fmt0(d.best) + ' km/h' : ''}</span></div>`;
    });
    html += '</div>';
  }
  box.innerHTML = html;
}

/* ============================ Impostazioni (UI) ============================ */
async function renderSettings() {
  $('#sPre').value = settings.pre; $('#sPreV').textContent = settings.pre + ' s';
  $('#sPost').value = settings.post; $('#sPostV').textContent = settings.post + ' s';
  $('#sMode').value = settings.mode;
  $('#sSens').value = settings.sens; $('#sSensV').textContent = settings.sens;
  $('#sFps').value = String(settings.fps);
  $('#sFacing').value = settings.facing;
  $('#sQuality').value = settings.quality;
  $('#sMax').value = String(settings.maxClips);
  updateCalibState();
  let txt = '';
  try {
    const n = (await DB.allMeta()).length;
    txt = `${n} clip salvate`;
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      txt += ` · ${Math.round((e.usage || 0) / 1048576)} MB usati su ${Math.round((e.quota || 0) / 1048576)} MB disponibili`;
    }
  } catch (e) { /* ignora */ }
  $('#storageInfo').textContent = txt;
}

function bindSettings() {
  const range = (id, key, vid, suffix) => {
    $(id).oninput = e => {
      settings[key] = +e.target.value;
      $(vid).textContent = e.target.value + suffix;
      saveSettings(); updateManualLabel();
    };
  };
  range('#sPre', 'pre', '#sPreV', ' s');
  range('#sPost', 'post', '#sPostV', ' s');
  range('#sSens', 'sens', '#sSensV', '');
  const sel = (id, key, num) => {
    $(id).onchange = e => {
      settings[key] = num ? +e.target.value : e.target.value;
      saveSettings();
      if (cap.running && (key === 'fps' || key === 'facing')) toast('Ferma e riavvia la registrazione per applicare');
    };
  };
  sel('#sMode', 'mode', false);
  sel('#sFps', 'fps', true);
  sel('#sFacing', 'facing', false);
  sel('#sQuality', 'quality', false);
  sel('#sMax', 'maxClips', true);
  $('#btnResetCalib').onclick = () => { settings.calib = null; saveSettings(); updateCalibState(); toast('Scala azzerata'); };
  $('#btnClearAll').onclick = async () => {
    if (!confirm('Eliminare TUTTE le clip, anche i preferiti?')) return;
    await DB.clear();
    renderSettings();
    toast('Clip eliminate');
  };
}

/* ============================ Carica un video ============================ */
const VID = { url: null, dur: 0, busy: false, cancel: false };
function isFree(m) { return m.source === 'manuale' || m.source === 'video'; }

function updateVidInfo() {
  const s = (+$('#vStart').value) / 10;
  const len = Math.max(0, Math.min(8, VID.dur - s));
  $('#vInfo').textContent = `Inizio a ${s.toFixed(1).replace('.', ',')} s · analizzo ${len.toFixed(1).replace('.', ',')} s di video (durata totale ${VID.dur.toFixed(1).replace('.', ',')} s)`;
}

function openVideoModal(file) {
  if (VID.url) URL.revokeObjectURL(VID.url);
  VID.url = URL.createObjectURL(file);
  const v = $('#vPrev');
  $('#vProg').textContent = '';
  $('#vGo').disabled = true;
  $('#vModal').classList.add('open');
  v.onloadedmetadata = () => {
    VID.dur = isFinite(v.duration) ? v.duration : 0;
    const sl = $('#vStart');
    sl.max = Math.max(0, Math.floor((VID.dur - 1) * 10));
    sl.value = 0;
    sl.disabled = VID.dur <= 8;
    updateVidInfo();
    $('#vGo').disabled = VID.dur < 1;
    if (VID.dur < 1) toast('Video troppo corto');
  };
  v.onerror = () => { toast('Non riesco a leggere questo video'); closeVideoModal(); };
  v.src = VID.url;
  v.load();
}

function closeVideoModal() {
  VID.cancel = true;
  const v = $('#vPrev');
  v.pause();
  v.removeAttribute('src');
  v.load();
  $('#vModal').classList.remove('open');
}

function seekTo(v, t) {
  return new Promise(res => {
    if (Math.abs(v.currentTime - t) < 0.001) { res(); return; }
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      v.removeEventListener('seeked', onSeeked);
      clearTimeout(guard);
      res();
    };
    const onSeeked = () => setTimeout(done, 60); // lascia il tempo a Safari di decodificare il fotogramma
    const guard = setTimeout(done, 2000);
    v.addEventListener('seeked', onSeeked);
    v.currentTime = t;
  });
}

/* Lettura per riproduzione: prende ogni fotogramma realmente mostrato, con il suo tempo esatto.
   Più affidabile dei salti (seek), che su alcuni telefoni restituiscono fotogrammi ripetuti. */
async function captureByPlayback(v, o) {
  if (!('requestVideoFrameCallback' in v)) return null;
  const { start, len, sps, k, cx, cv, sx, W, H, AW, AH } = o;
  const gray = [], blobPromises = [], times = [];
  await seekTo(v, start);
  let last = -1, base = null, done = false, guard = 0;
  await new Promise(resolve => {
    const finish = () => { if (done) return; done = true; clearTimeout(guard); v.pause(); resolve(); };
    guard = setTimeout(finish, (len / 0.5) * 1000 + 6000);
    v.onended = finish;
    const cb = (now, m) => {
      if (done) return;
      const mt = m.mediaTime;
      if (VID.cancel || mt >= start + len) { finish(); return; }
      if (last < 0 || mt - last >= (1 / sps) * 0.9) {
        if (base === null) base = mt;
        cx.drawImage(v, 0, 0, W, H);
        blobPromises.push(new Promise(r => cv.toBlob(r, 'image/jpeg', QUALITY[settings.quality] || 0.65)));
        sx.drawImage(v, 0, 0, AW, AH);
        const px = sx.getImageData(0, 0, AW, AH).data;
        const g = new Uint8Array(AW * AH);
        for (let a = 0, b = 0; a < g.length; a++, b += 4) g[a] = (px[b] * 77 + px[b + 1] * 150 + px[b + 2] * 29) >> 8;
        gray.push(g);
        times.push((mt - base) / k);
        last = mt;
        if (gray.length % 8 === 0) $('#vProg').textContent = `Leggo il video… ${Math.round((mt - start) / len * 100)}%`;
      }
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
    v.playbackRate = 0.5;
    v.play().catch(finish);
  });
  v.onended = null;
  if (gray.length < 8) return null;
  const blobs = await Promise.all(blobPromises);
  return { gray, blobs, times };
}

/* Tiro da dietro: rilevatore di pallone in un secondo Worker (i fotogrammi li decodifico qui). */
function runBehind(blobs, times, onProg) {
  return new Promise(resolve => {
    let bw;
    try { bw = new Worker('behind-worker.js'); } catch (e) { resolve({ ok: false, reason: 'analisi da dietro non disponibile su questo browser' }); return; }
    const cv = document.createElement('canvas');
    const cx = cv.getContext('2d', { willReadFrequently: true });
    const finish = r => { clearInterval(poll); bw.terminate(); resolve(r); };
    const poll = setInterval(() => { if (VID.cancel) bw.postMessage({ type: 'cancel' }); }, 400);
    bw.onerror = () => finish({ ok: false, reason: 'analisi da dietro non riuscita' });
    bw.onmessage = async ev => {
      const m = ev.data;
      if (m.type === 'progress') onProg(m.text, m.p);
      else if (m.type === 'log') console.log('[dietro]', m.text);
      else if (m.type === 'done') finish(m.result);
      else if (m.type === 'frame') {
        try {
          const bmp = await createImageBitmap(blobs[Math.min(blobs.length - 1, m.i)]);
          const FW = m.W || 585, H = Math.round(FW * bmp.height / bmp.width);
          cv.width = FW; cv.height = H;
          cx.drawImage(bmp, 0, 0, FW, H);
          if (bmp.close) bmp.close();
          const d = cx.getImageData(0, 0, FW, H);
          bw.postMessage({ type: 'frame', id: m.id, buf: d.data.buffer, width: FW, height: H }, [d.data.buffer]);
        } catch (e) { finish({ ok: false, reason: 'non riesco a leggere i fotogrammi' }); }
      }
    };
    bw.postMessage({ type: 'run', times });
  });
}

async function analyzeVideo() {
  if (VID.busy) return;
  const v = $('#vPrev');
  v.pause();
  const k = +$('#vSlow').value || 1;
  const sps = +$('#vSample').value || 30;
  const start = (+$('#vStart').value) / 10;
  const len = Math.min(8, VID.dur - start);
  const N = Math.floor(len * sps);
  if (N < 8) { toast('Video troppo corto da questo punto'); return; }

  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh) { toast('Video non leggibile'); return; }
  const W = Math.min(960, vw), H = Math.round(W * vh / vw);
  const AW = 320, AH = Math.round(AW * vh / vw);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const cx = cv.getContext('2d');
  const sm = document.createElement('canvas'); sm.width = AW; sm.height = AH;
  const sx = sm.getContext('2d', { willReadFrequently: true });

  VID.busy = true; VID.cancel = false;
  $('#vGo').disabled = true;
  let gray = [], blobs = [], times = [];
  try {
    const played = await captureByPlayback(v, { start, len, sps, k, cx, cv, sx, W, H, AW, AH });
    if (VID.cancel) throw new Error('annullato');
    if (played) { gray = played.gray; blobs = played.blobs; times = played.times; }
    else for (let i = 0; i < N; i++) {
      if (VID.cancel) throw new Error('annullato');
      await seekTo(v, Math.min(VID.dur - 0.01, start + i / sps));
      cx.drawImage(v, 0, 0, W, H);
      const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', QUALITY[settings.quality] || 0.65));
      sx.drawImage(v, 0, 0, AW, AH);
      const px = sx.getImageData(0, 0, AW, AH).data;
      const g = new Uint8Array(AW * AH);
      for (let a = 0, b = 0; a < g.length; a++, b += 4) g[a] = (px[b] * 77 + px[b + 1] * 150 + px[b + 2] * 29) >> 8;
      gray.push(g); blobs.push(blob);
      times.push(i / (sps * k)); // tempo reale (con lo slow-motion il video è dilatato di k volte)
      if (i % 4 === 0) $('#vProg').textContent = `Leggo il video… ${Math.round(i / N * 100)}%`;
    }
    $('#vProg').textContent = 'Cerco il pallone…';
    let analysis = await runAnalysis({ frames: gray, times, w: AW, h: AH, impactTime: null, mpp: null });
    if ((!analysis.ok || analysis.confidence !== 'alta') && !VID.cancel) {
      // di lato non c'è un tiro sicuro: provo con il rilevatore di pallone (riprese da dietro o da lontano)
      const side = analysis;
      const t0 = Date.now();
      analysis = await runBehind(blobs, times, (text, p) => {
        const el = (Date.now() - t0) / 1000;
        $('#vProg').textContent = `Da dietro: ${text} ${Math.round(p * 100)}% (${Math.round(el)} s, può richiedere qualche minuto)`;
      });
      if (VID.cancel) throw new Error('annullato');
      if (analysis.ok) { // porto i punti nelle coordinate dell'analisi (AW × AH)
        const k = AW / 585;
        analysis.points = analysis.points.map(p => ({ t: p.t, x: p.x * k, y: p.y * k }));
        analysis.pred = (analysis.pred || []).map(p => ({ t: p.t, x: p.x * k, y: p.y * k }));
        analysis.launchIndex = Math.max(0, Math.min(blobs.length - 1, analysis.launchIndex));
      } else if (side.ok || (!analysis.kickIndex && !/modello|non disponibile|non riuscita/.test(analysis.reason || ''))) analysis = side;
    }

    let thumbIdx = Math.floor(blobs.length / 2);
    if (analysis.ok) thumbIdx = analysis.launchIndex;
    const meta = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      ts: Date.now(), w: W, h: H, aw: AW, ah: AH,
      times, source: 'video', analysis, calib: null, fav: false,
      thumb: blobs[thumbIdx]
    };
    await DB.putClip(meta, blobs);
    await enforceLimit();
    VID.busy = false;
    closeVideoModal();
    if (analysis.ok && analysis.view === 'dietro') toast('Tiro da dietro trovato: direzione e percorso iniziale', 4000);
    else if (analysis.ok) toast('Tiro trovato: tocca «Imposta scala» per i km/h', 4000);
    else toast('Palla non rilevata: prova a iniziare più vicino al tiro', 4000);
    await openPlayer(meta.id);
  } catch (e) {
    VID.busy = false;
    $('#vGo').disabled = false;
    $('#vProg').textContent = '';
    if (e.message !== 'annullato') { console.error(e); toast('Analisi non riuscita: spazio esaurito o video non supportato'); }
  }
}

$('#btnUpload').onclick = () => $('#fileVideo').click();
$('#fileVideo').onchange = e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (f) openVideoModal(f);
};
$('#vStart').oninput = e => {
  const t = (+e.target.value) / 10;
  updateVidInfo();
  try { $('#vPrev').currentTime = t; } catch (err) { /* ignora */ }
};
$('#vGo').onclick = analyzeVideo;
$('#vCancel').onclick = closeVideoModal;

/* ============================ Avvio ============================ */
$('#btnStart').onclick = async () => {
  if (cap.running) stopCapture(); else await startCapture();
};
$('#btnManual').onclick = () => registerShot(now() - settings.post, 'manuale', true);
$('#btnCalib').onclick = calibrateLive;
$('#btnLastOpen').onclick = () => { if (cap.lastMetaId) openPlayer(cap.lastMetaId); };

let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  $('#btnInstall').hidden = false;
});
$('#btnInstall').onclick = async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  $('#btnInstall').hidden = true;
};

(async function init() {
  bindSettings();
  updateCalibState();
  updateManualLabel();
  try { await DB.open(); } catch (e) { toast('Archivio clip non disponibile su questo browser'); }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
