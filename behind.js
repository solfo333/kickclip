/* KickClip – behind.js: tiro ripreso DA DIETRO.
   1) trova il pallone fermo: candidati "fermi" (stessa posizione in più fotogrammi, tondi, non erba)
      confermati dal rilevatore YOLO (darknet.js);
   2) trova il momento del calcio: l'aspetto della zona attorno al pallone cambia;
   3) segue il pallone nei primi fotogrammi di volo con il rilevatore (ritagli attorno alla posizione prevista);
   4) ricava la direzione nell'immagine (angolo rispetto alla linea dritta, + = destra).
   NON stima i km/h: da dietro la velocità dipende dallo zoom e dalla dimensione del pallone, ancora non affidabili.
   getFrame(i) -> {data: RGBA, width, height} (anche Promise). */
(function (root) {
  'use strict';

  function grayOf(f, x0, y0, x1, y1) {
    const w = f.width, out = new Float32Array((x1 - x0) * (y1 - y0)); let k = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++, k++) {
      const p = (y * w + x) * 4; out[k] = (f.data[p] * 77 + f.data[p + 1] * 150 + f.data[p + 2] * 29) / 256;
    }
    return out;
  }

  function crop(f, cx, cy, size) {
    const w = f.width, h = f.height;
    let x0 = Math.round(cx - size / 2), y0 = Math.round(cy - size / 2);
    x0 = Math.max(0, Math.min(w - size, x0)); y0 = Math.max(0, Math.min(h - size, y0));
    const sw = Math.min(size, w), sh = Math.min(size, h);
    const data = new Uint8ClampedArray(sw * sh * 4);
    for (let y = 0; y < sh; y++) data.set(f.data.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + sw) * 4), y * sw * 4);
    return { img: { data, width: sw, height: sh }, x0, y0 };
  }

  /* candidati tondi: bianchi, oppure non erba (i palloni hanno disegni diversi) */
  function candidates(f) {
    const w = f.width, h = f.height, n = w * h, sc = w / 585;
    const white = new Uint8Array(n), ng = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = f.data[p], g = f.data[p + 1], b = f.data[p + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), s = mx ? 255 * (mx - mn) / mx : 0;
      let hue = 0;
      if (mx !== mn) {
        const d = mx - mn;
        hue = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
        if (hue < 0) hue += 360;
      }
      const grass = hue >= 60 && hue <= 180 && s > 70 && mx > 35;
      if (mx > 165 && s < 70) white[i] = 1;
      if (!grass) ng[i] = 1;
    }
    const out = [];
    const run = (mask, amin, amax, fillMin, kind) => {
      const seen = new Uint8Array(n), st = new Int32Array(n);
      for (let s0 = 0; s0 < n; s0++) {
        if (!mask[s0] || seen[s0]) continue;
        let sp = 0, a = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = 0, y1 = 0, big = false;
        st[sp++] = s0; seen[s0] = 1;
        while (sp) {
          const q = st[--sp], y = (q / w) | 0, x = q - y * w; a++; sx += x; sy += y;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          if (a > amax) big = true;
          if (x > 0 && mask[q - 1] && !seen[q - 1]) { seen[q - 1] = 1; st[sp++] = q - 1; }
          if (x < w - 1 && mask[q + 1] && !seen[q + 1]) { seen[q + 1] = 1; st[sp++] = q + 1; }
          if (y > 0 && mask[q - w] && !seen[q - w]) { seen[q - w] = 1; st[sp++] = q - w; }
          if (y < h - 1 && mask[q + w] && !seen[q + w]) { seen[q + w] = 1; st[sp++] = q + w; }
        }
        if (big || a < amin) continue;
        const bw = x1 - x0 + 1, bh = y1 - y0 + 1, ar = bw / bh;
        if (ar < 0.5 || ar > 2 || a / (bw * bh) < fillMin) continue;
        out.push({ x: sx / a, y: sy / a, d: Math.sqrt(4 * a / Math.PI), a, kind, fill: a / (bw * bh), ar });
      }
    };
    run(white, 10 * sc * sc, 2500 * sc * sc, 0.55, 'bianco');
    run(ng, 40 * sc * sc, 9000 * sc * sc, 0.6, 'altro');
    return out;
  }

  const near = (c, list, tol) => list.some((o) => Math.hypot(o.x - c.x, o.y - c.y) <= tol);

  async function analyzeBehind(opt) {
    const { getFrame, times, net } = opt, N = times.length;
    const prog = opt.onProgress || (() => {}), cancelled = opt.cancelled || (() => false);
    const log = opt.log || (() => {});
    if (N < 6) return { ok: false, reason: 'clip troppo corto' };

    // 1) pallone fermo
    prog('Cerco il pallone fermo…', 0.02);
    // il pallone fermo è nello stesso punto in quasi tutti i primi fotogrammi (il giocatore invece si muove)
    const refIdx = [0, 0.04, 0.08, 0.12, 0.16].map((q, k) => Math.max(k, Math.floor(N * q)));
    const f0 = await getFrame(refIdx[0]);
    const w = f0.width, h = f0.height, sc = w / 585;
    const cA = candidates(f0);
    const others = [];
    for (const i of refIdx.slice(1)) others.push(candidates(await getFrame(i)));
    const hasSame = (c, l) => l.some((o) => Math.hypot(o.x - c.x, o.y - c.y) <= 3 * sc && Math.abs(o.d - c.d) < 0.3 * c.d);
    const still = cA.filter((c) => others.filter((l) => hasSame(c, l)).length >= 2);
    // più "pallone" = più tondo e di dimensione plausibile; niente doppioni (bianco + non erba sullo stesso pallone)
    const ballness = (c) => (1 - Math.min(1, Math.abs(c.fill - 0.785) / 0.3)) + (1 - Math.min(1, Math.abs(Math.log(c.ar)))) +
      (c.d / sc >= 12 && c.d / sc <= 90 ? 0.8 : 0) + (c.d / sc >= 25 ? 0.3 : 0);
    still.sort((a, b) => ballness(b) - ballness(a));
    for (let k = still.length - 1; k >= 0; k--) if (still.some((o, j) => j < k && Math.hypot(o.x - still[k].x, o.y - still[k].y) < Math.max(o.d, still[k].d))) still.splice(k, 1);
    log('candidati fermi', still.length, still.slice(0, 10).map((c) => [Math.round(c.x), Math.round(c.y), Math.round(c.d), c.kind, +ballness(c).toFixed(2)].join(':')).join(' '), '| palla?', still.filter((c) => Math.hypot(c.x - 318, c.y - 840) < 30).map((c) => [Math.round(c.x), Math.round(c.y), Math.round(c.d), +c.fill.toFixed(2), +c.ar.toFixed(2)].join(':')).join(' '));
    let rest = null, tried = 0;
    for (const c of still.slice(0, 8)) {
      if (cancelled()) return { ok: false, reason: 'annullato' };
      prog('Controllo il pallone…', 0.05 + 0.1 * (tried++ / 8));
      const cs = 160, cr = crop(f0, c.x, c.y, cs);
      const dets = net.detect(cr.img, { size: 256, conf: 0.25 });
      const hit = dets.find((r) => Math.hypot(r.x + cr.x0 - c.x, r.y + cr.y0 - c.y) <= Math.max(8 * sc, c.d));
      if (hit && (!rest || hit.score > rest.score)) rest = { x: c.x, y: c.y, d: c.d, score: hit.score, bbox: (hit.w + hit.h) / 2 };
    }
    if (!rest) return { ok: false, reason: 'pallone fermo non trovato: inquadra la palla ferma per almeno un secondo prima del tiro' };
    log('pallone fermo', rest);

    // 2) momento del calcio
    prog('Cerco il momento del calcio…', 0.2);
    const r = Math.ceil(rest.d * 0.9) + 2;
    const bx0 = Math.max(0, Math.round(rest.x - r)), by0 = Math.max(0, Math.round(rest.y - r));
    const bx1 = Math.min(w, Math.round(rest.x + r)), by1 = Math.min(h, Math.round(rest.y + r));
    const ref = [];
    for (const i of refIdx.slice(0, 3)) ref.push(grayOf(await getFrame(i), bx0, by0, bx1, by1));
    const base = ref[0].map((_, k) => (ref[0][k] + ref[1][k] + ref[2][k]) / 3);
    const diff = [];
    for (let i = 0; i < N; i++) {
      if (cancelled()) return { ok: false, reason: 'annullato' };
      const g = grayOf(await getFrame(i), bx0, by0, bx1, by1); let s = 0;
      for (let k = 0; k < g.length; k++) s += Math.abs(g[k] - base[k]);
      diff.push(s / g.length);
    }
    // il calcio è un salto improvviso (arriva la gamba / parte il pallone), non una deriva lenta di luce e ombre
    let kick = -1;
    for (let i = 4; i < N - 1; i++) {
      const before = Math.max(diff[i - 1], diff[i - 2], diff[i - 3]);
      if (diff[i] > before + 8 && diff[i + 1] > before + 8) { kick = i; break; }
    }
    log('diff', diff.map((d) => Math.round(d)).join(','));
    if (kick < 0) return { ok: false, reason: 'non vedo il calcio: il pallone non si muove nel video', rest };

    // 3) primi fotogrammi di volo
    const pts = [{ t: times[Math.max(0, kick - 1)], i: Math.max(0, kick - 1), x: rest.x, y: rest.y, d: rest.d, score: rest.score }];
    let last = pts[0], vel = null, miss = 0;
    const maxK = Math.min(N - 1, kick + (opt.maxFlight || 10));
    for (let i = kick; i <= maxK && miss < (pts.length > 1 ? 3 : 5); i++) {
      if (cancelled()) return { ok: false, reason: 'annullato' };
      prog('Seguo il pallone…', 0.3 + 0.65 * ((i - kick) / (maxK - kick + 1)));
      const dt = times[i] - last.t;
      const px = vel ? last.x + vel.x * dt : last.x, py = vel ? last.y + vel.y * dt : last.y - rest.d * 3;
      // finestra di ricerca: grande finché non conosco la velocità, poi attorno alla posizione prevista
      const spd = vel ? Math.hypot(vel.x, vel.y) * dt : 0;
      const cs = Math.min(w, h, vel ? Math.round(Math.max(224, Math.min(352, 2.2 * spd + 128))) : 352);
      const f = await getFrame(i), cr = crop(f, px, py, cs);
      const dets = net.detect(cr.img, { size: Math.max(256, Math.round(cs * 1.35 / 32) * 32), conf: 0.2 });
      const reach = Math.max(rest.d * 4, cs * 0.5);
      const cand = dets.map((q) => ({ x: q.x + cr.x0, y: q.y + cr.y0, score: q.score, bbox: (q.w + q.h) / 2 }))
        // il pallone parte: scarta quello ancora fermo al punto di partenza
        .filter((q) => Math.hypot(q.x - rest.x, q.y - rest.y) > rest.d * 0.8 && Math.hypot(q.x - px, q.y - py) <= reach);
      if (!cand.length) { miss++; continue; }
      miss = 0;
      cand.sort((a, b) => Math.hypot(a.x - px, a.y - py) - Math.hypot(b.x - px, b.y - py));
      const c = cand[0];
      if (i === kick && Math.hypot(c.x - rest.x, c.y - rest.y) < rest.d * 1.2) continue;
      const p = { t: times[i], i, x: c.x, y: c.y, d: c.bbox, score: c.score };
      const dtp = p.t - last.t;
      if (dtp > 1e-6) vel = { x: (p.x - last.x) / dtp, y: (p.y - last.y) / dtp };
      pts.push(p); last = p;
    }
    log('punti', pts.map((p) => [p.i, Math.round(p.x), Math.round(p.y), +p.score.toFixed(2)].join(':')).join(' '));
    const res = { view: 'dietro', kickIndex: kick, kickTime: times[kick], rest, points: pts, n: pts.length, launchIndex: Math.max(0, kick - 1), confidence: 'bassa', speedPx: null, pass: 'dietro' };
    if (pts.length < 3) return Object.assign(res, { ok: false, reason: 'calcio trovato, ma ho perso il pallone subito dopo' });

    // 4) direzione nell'immagine (0° = dritto davanti a te, + = destra)
    const t0 = pts[0].t, A = [], B = [], T = [];
    pts.slice(1).forEach((p) => { T.push(p.t - t0); A.push(p.x); B.push(p.y); });
    const slope = (y) => { const n = T.length, mt = T.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
      let num = 0, den = 0; for (let k = 0; k < n; k++) { num += (T[k] - mt) * (y[k] - my); den += (T[k] - mt) ** 2; } return den ? num / den : 0; };
    const vx = slope(A), vy = slope(B);
    res.vx = vx; res.vy = vy;
    res.angleDeg = Math.atan2(vx, -vy) * 180 / Math.PI;
    res.direction = Math.abs(res.angleDeg) < 4 ? 'dritto' : res.angleDeg > 0 ? 'destra' : 'sinistra';
    res.ok = true;
    return res;
  }

  const api = { analyzeBehind, candidates };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.KickBehind = api;
})(typeof self !== 'undefined' ? self : this);
