/* KickClip – analysis.js
 * Rilevamento della palla e stima della velocità del tiro a partire da una
 * sequenza di frame in scala di grigi (uno Uint8Array w*h per frame).
 * Funziona nel browser, in un Web Worker e in Node (per i test).
 *
 * Idea: differenza a 3 frame (|f[i]-f[i-1]| AND |f[i+1]-f[i]|) isola gli oggetti
 * in movimento nella posizione del frame i; si tengono i blob "tondi e piccoli",
 * poi si cerca la catena di blob con moto coerente (la palla) vicino all'impatto
 * e la si interpola con un polinomio per ottenere velocità, angolo e altezza.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KickAnalysis = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BALL_DIAMETER_M = 0.22;

  /* ---------- componenti connesse (4-connettività) ---------- */
  function components(mask, w, h, stack) {
    const out = [];
    const n = w * h;
    for (let s = 0; s < n; s++) {
      if (mask[s] !== 1) continue;
      let sp = 0;
      stack[sp++] = s;
      mask[s] = 2;
      let area = 0, sx = 0, sy = 0, minx = w, maxx = -1, miny = h, maxy = -1;
      while (sp > 0) {
        const p = stack[--sp];
        const y = (p / w) | 0, x = p - y * w;
        area++; sx += x; sy += y;
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
        if (x > 0 && mask[p - 1] === 1) { mask[p - 1] = 2; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] === 1) { mask[p + 1] = 2; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] === 1) { mask[p - w] = 2; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] === 1) { mask[p + w] = 2; stack[sp++] = p + w; }
      }
      out.push({ x: sx / area, y: sy / area, a: area, bw: maxx - minx + 1, bh: maxy - miny + 1 });
    }
    return out;
  }

  /* ---------- candidati "palla" per ogni frame ---------- */
  function findCandidates(frames, w, h, p) {
    const n = frames.length, N = w * h;
    const mask = new Uint8Array(N), stack = new Int32Array(N);
    const cands = new Array(n);
    for (let i = 0; i < n; i++) cands[i] = [];
    for (let i = 1; i < n - 1; i++) {
      const fa = frames[i - 1], fb = frames[i], fc = frames[i + 1];
      let fg = 0;
      for (let k = 0; k < N; k++) {
        const v = fb[k];
        const m = (Math.abs(v - fa[k]) > p.diffThr && Math.abs(v - fc[k]) > p.diffThr) ? 1 : 0;
        mask[k] = m;
        fg += m;
      }
      // niente movimento, oppure troppo (scossa della camera / cambio di luce)
      if (fg === 0 || fg > N * p.maxFgFrac) continue;
      const keep = [];
      for (const c of components(mask, w, h, stack)) {
        if (c.a < p.minArea || c.a > p.maxArea) continue;
        const ar = c.bw / c.bh;
        if (ar < p.arMin || ar > p.arMax) continue;
        if (c.a / (c.bw * c.bh) < p.fillMin) continue;
        keep.push(c);
      }
      if (keep.length > 25) {
        keep.sort((u, v) => Math.abs(u.a - p.expArea) - Math.abs(v.a - p.expArea));
        keep.length = 25;
      }
      for (const c of keep) cands[i].push({ i, x: c.x, y: c.y, a: c.a });
    }
    return cands;
  }

  /* ---------- regressione polinomiale (minimi quadrati) ---------- */
  function polyfit(ts, vs, deg) {
    const m = deg + 1;
    const A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
    for (let k = 0; k < ts.length; k++) {
      const pw = [1];
      for (let d = 1; d <= 2 * deg; d++) pw[d] = pw[d - 1] * ts[k];
      for (let r = 0; r < m; r++) {
        for (let c = 0; c < m; c++) A[r][c] += pw[r + c];
        A[r][m] += vs[k] * pw[r];
      }
    }
    for (let c = 0; c < m; c++) {
      let piv = c;
      for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      if (Math.abs(A[piv][c]) < 1e-12) return null;
      const tmp = A[c]; A[c] = A[piv]; A[piv] = tmp;
      for (let r = 0; r < m; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k];
      }
    }
    return A.map((row, i) => row[m] / row[i]);
  }
  const evalPoly = (co, t) => co.reduce((s, c, i) => s + c * Math.pow(t, i), 0);

  function fitChain(chain, times) {
    const n = chain.length;
    const t0 = times[chain[0].i];
    const ts = chain.map(c => times[c.i] - t0);
    const xs = chain.map(c => c.x), ys = chain.map(c => c.y);
    // x: lineare (quadratico se la catena è lunga, per modellare la resistenza dell'aria)
    // y: quadratico (gravità) se ci sono abbastanza punti
    const bx = polyfit(ts, xs, n >= 8 ? 2 : 1);
    const by = polyfit(ts, ys, n >= 6 ? 2 : 1);
    if (!bx || !by) return null;
    let se = 0;
    for (let k = 0; k < n; k++) {
      const ex = evalPoly(bx, ts[k]) - xs[k], ey = evalPoly(by, ts[k]) - ys[k];
      se += ex * ex + ey * ey;
    }
    return { bx, by, t0, rms: Math.sqrt(se / n) };
  }

  /* ---------- estensione di una catena con moto coerente ---------- */
  function extendChain(c1, c2, cands, times, p) {
    const chain = [c1, c2];
    let prev = c1, last = c2, miss = 0;
    for (let k = last.i + 1; k < cands.length; k++) {
      if (times[k] > p.tMax) break;
      const dtv = times[last.i] - times[prev.i];
      if (dtv <= 0) break;
      const dx = last.x - prev.x, dy = last.y - prev.y;
      const vx = dx / dtv, vy = dy / dtv;
      const dt = times[k] - times[last.i];
      const px = last.x + vx * dt, py = last.y + vy * dt;
      const r = Math.max(p.rMin, p.rK * Math.hypot(vx, vy) * dt + p.rAdd);
      let best = null, bd = Infinity;
      for (const c of cands[k]) {
        const d = Math.hypot(c.x - px, c.y - py);
        if (d >= r || d >= bd) continue;
        if ((c.x - last.x) * dx + (c.y - last.y) * dy <= p.invTol) continue; // niente inversioni
        bd = d; best = c;
      }
      if (best) { chain.push(best); prev = last; last = best; miss = 0; }
      else if (++miss > p.maxMiss) break;
    }
    return chain;
  }

  function searchChains(cands, times, p) {
    const n = cands.length;
    let best = null;
    for (let i = 0; i < n; i++) {
      if (times[i] < p.launchMin || times[i] > p.launchMax) continue;
      for (const c1 of cands[i]) {
        for (let j = i + 1; j <= Math.min(n - 1, i + p.maxGap); j++) {
          const gap = j - i;
          for (const c2 of cands[j]) {
            const step = Math.hypot(c2.x - c1.x, c2.y - c1.y) / gap;
            if (step < p.minStep || step > p.maxStep) continue;
            const chain = extendChain(c1, c2, cands, times, p);
            if (chain.length < p.minPoints) continue;
            const fit = fitChain(chain, times);
            if (!fit) continue;
            const score = chain.length - fit.rms * 0.5;
            if (!best || score > best.score) best = { chain, fit, score };
          }
        }
      }
    }
    return best;
  }

  /* ---------- API principale ----------
   * o.frames   : Array<Uint8Array> scala di grigi, w*h ciascuno
   * o.times    : secondi per frame (crescenti), relativi all'impatto se impactTime = 0
   * o.w, o.h   : dimensioni dei frame
   * o.impactTime: istante dell'impatto (null = cerca in tutto il clip)
   * o.mpp      : metri per pixel (null se non calibrato)
   */
  function analyzeClip(o) {
    const w = o.w, h = o.h;
    // scarta i fotogrammi identici al precedente (seek imprecisi, video con frame ripetuti):
    // con due frame uguali la differenza a 3 frame non vede più il pallone
    const frames = [], times = [], orig = [];
    for (let i = 0; i < o.frames.length; i++) {
      if (i > 0) {
        const a = o.frames[i], b = o.frames[i - 1];
        let same = true;
        for (let k = 0; k < a.length; k += 3) if (a[k] !== b[k]) { same = false; break; }
        if (same) continue;
      }
      frames.push(o.frames[i]); times.push(o.times[i]); orig.push(i);
    }
    const n = frames.length;
    if (n < 8) return { ok: false, reason: 'clip troppo corto' };
    const mpp = o.mpp > 0 ? o.mpp : null;
    const dtMed = (times[n - 1] - times[0]) / (n - 1);
    const ballPx = mpp ? BALL_DIAMETER_M / mpp : null;
    const expArea = ballPx ? Math.PI * Math.pow(ballPx / 2, 2) : 25;
    const free = o.impactTime == null;
    const common = {
      expArea,
      launchMin: free ? -Infinity : o.impactTime - 0.35,
      launchMax: free ? Infinity : o.impactTime + 0.45,
      tMax: free ? Infinity : o.impactTime + 2.0
    };
    const dThr = o.diffThr || 22;
    // 1° passaggio, severo: pochi falsi positivi, è quello di cui ci si può fidare
    const strict = Object.assign({}, common, {
      diffThr: dThr, maxFgFrac: 0.12,
      minArea: mpp ? Math.max(2, expArea * 0.3) : 3,
      maxArea: mpp ? Math.max(30, expArea * 7) : 220,
      minStep: mpp ? Math.max(1.5, 3 / mpp * dtMed) : 2,
      maxStep: mpp ? Math.min(w * 0.3, 45 / mpp * dtMed) : w * 0.3,
      minPoints: 5, arMin: 0.3, arMax: 3.3, fillMin: 0.35,
      rMin: 5, rK: 0.35, rAdd: 3, maxMiss: 2, invTol: 0, maxGap: 3
    });
    // 2° passaggio, largo: recupera i tiri sfocati o molto veloci che il primo scarta.
    // Il risultato è sempre a bassa affidabilità e passa dei controlli di buon senso.
    const loose = Object.assign({}, common, {
      diffThr: dThr - 3, maxFgFrac: 0.15,
      minArea: mpp ? Math.max(2, expArea * 0.2) : 2,
      maxArea: mpp ? Math.max(35, expArea * 8) : 250,
      minStep: mpp ? Math.max(1.0, 2 / mpp * dtMed) : 1.5,
      maxStep: mpp ? Math.min(w * 0.35, 55 / mpp * dtMed) : w * 0.35,
      minPoints: 6, arMin: 0.2, arMax: 4.5, fillMin: 0.25,
      rMin: 8, rK: 0.45, rAdd: 5, maxMiss: 3, invTol: -10, maxGap: 4
    });

    const attempt = (p, isLoose) => {
      const cands = findCandidates(frames, w, h, p);
      const found = searchChains(cands, times, p);
      if (!found) return null;
      const { chain, fit } = found;
      const pts = chain.map(c => ({ i: orig[c.i], t: times[c.i], x: c.x, y: c.y }));
      const vx0 = fit.bx[1], vy0 = fit.by[1]; // velocità (px/s) al primo punto tracciato
      const speedPx = Math.hypot(vx0, vy0);
      let ymin = Infinity, pathPx = 0;
      for (let k = 0; k < pts.length; k++) {
        if (pts[k].y < ymin) ymin = pts[k].y;
        if (k) pathPx += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y);
      }
      // controllo di buon senso del 2° passaggio: un tiro percorre strada e va veloce
      if (isLoose && (pathPx < Math.max(25, 0.08 * w) || speedPx < 0.5 * w)) return null;
      const n2 = pts.length, rms = fit.rms;
      // controllo di qualità: un pallone vero ha una traiettoria liscia. Le catene corte e
      // "storte" sono coincidenze di disturbi casuali e vengono scartate.
      if (rms > 3 || (n2 < 8 && rms > 1.5)) return null;
      let confidence = (n2 >= 10 && rms <= 1.5) ? 'alta' : (n2 >= 6 && rms <= 3) ? 'media' : 'bassa';
      if (isLoose) confidence = 'bassa';
      return {
        ok: true,
        points: pts,
        launchIndex: pts[0].i,
        speedPx,
        angleDeg: Math.atan2(-vy0, Math.abs(vx0)) * 180 / Math.PI, // + = verso l'alto
        heightPx: Math.max(0, pts[0].y - ymin),
        pathPx,
        spanPx: Math.abs(pts[n2 - 1].x - pts[0].x),
        direction: vx0 >= 0 ? 'destra' : 'sinistra',
        rms,
        n: n2,
        confidence,
        pass: isLoose ? 'larga' : 'severa'
      };
    };

    let res = attempt(strict, false);
    if (!res && o.fallback !== false) res = attempt(loose, true);
    return res || { ok: false, reason: 'palla non rilevata' };
  }

  return { analyzeClip, BALL_DIAMETER_M };
});
