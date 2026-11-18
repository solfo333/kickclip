/* Mini rilevatore di oggetti (YOLOv4-tiny, rete addestrata su COCO) in JavaScript puro.
   Serve a trovare il «pallone» (classe 32) nei fotogrammi. Nessuna libreria.
   Uso: const net = Darknet.create(spec, arrayBufferPesi);
        const dets = net.detect({data: RGBA, width, height}, {size: 416, conf: 0.15});  // [{x,y,w,h,score}]
   Funziona sia nel browser sia in Node. */
(function (root) {
  'use strict';
  const BALL = 32;

  function half(h) { // float16 -> float32
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0) return s * Math.pow(2, -14) * (m / 1024);
    if (e === 31) return m ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + m / 1024);
  }

  function create(spec, buf) {
    const u16 = new Uint16Array(buf);
    const lut = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) lut[i] = half(i);
    const layers = spec.layers.map((d) => {
      const L = Object.assign({}, d);
      if (d.t === 'convolutional') {
        L.w = new Float32Array(d.wl); for (let i = 0; i < d.wl; i++) L.w[i] = lut[u16[d.wo + i]];
        L.b = new Float32Array(d.n); for (let i = 0; i < d.n; i++) L.b[i] = lut[u16[d.bo + i]];
      }
      return L;
    });
    const netw = spec.w, neth = spec.h;

    let colBuf = new Float32Array(1);
    function conv(x, C, H, W, L) {
      const k = L.k, s = L.s, p = k >> 1, n = L.n;
      const Ho = Math.floor((H + 2 * p - k) / s) + 1, Wo = Math.floor((W + 2 * p - k) / s) + 1, P = Ho * Wo;
      const out = new Float32Array(n * P), K = C * k * k, w = L.w;
      let cols;
      if (k === 1 && s === 1) cols = x; // nessuna riorganizzazione
      else {
        if (colBuf.length < K * P) colBuf = new Float32Array(K * P);
        cols = colBuf; cols.fill(0, 0, K * P);
        for (let c = 0; c < C; c++) for (let ky = 0; ky < k; ky++) for (let kx = 0; kx < k; kx++) {
          const row = ((c * k + ky) * k + kx) * P, dy = ky - p, dx = kx - p;
          const oy0 = Math.max(0, Math.ceil(-dy / s)), oy1 = Math.min(Ho - 1, Math.floor((H - 1 - dy) / s));
          const ox0 = Math.max(0, Math.ceil(-dx / s)), ox1 = Math.min(Wo - 1, Math.floor((W - 1 - dx) / s));
          for (let oy = oy0; oy <= oy1; oy++) {
            let ip = c * H * W + (oy * s + dy) * W + ox0 * s + dx, op = row + oy * Wo + ox0;
            for (let ox = ox0; ox <= ox1; ox++, ip += s, op++) cols[op] = x[ip];
          }
        }
      }
      let oc = 0;
      for (; oc + 4 <= n; oc += 4) {
        const o0 = oc * P, o1 = o0 + P, o2 = o1 + P, o3 = o2 + P;
        const b0 = L.b[oc], b1 = L.b[oc + 1], b2 = L.b[oc + 2], b3 = L.b[oc + 3];
        for (let q = 0; q < P; q++) { out[o0 + q] = b0; out[o1 + q] = b1; out[o2 + q] = b2; out[o3 + q] = b3; }
        const w0 = oc * K, w1 = w0 + K, w2 = w1 + K, w3 = w2 + K;
        for (let j = 0; j < K; j++) {
          const a0 = w[w0 + j], a1 = w[w1 + j], a2 = w[w2 + j], a3 = w[w3 + j], row = j * P;
          for (let q = 0; q < P; q++) {
            const v = cols[row + q];
            out[o0 + q] += a0 * v; out[o1 + q] += a1 * v; out[o2 + q] += a2 * v; out[o3 + q] += a3 * v;
          }
        }
      }
      for (; oc < n; oc++) { // resto (n non multiplo di 4)
        const o0 = oc * P, w0 = oc * K;
        out.fill(L.b[oc], o0, o0 + P);
        for (let j = 0; j < K; j++) { const a0 = w[w0 + j], row = j * P; for (let q = 0; q < P; q++) out[o0 + q] += a0 * cols[row + q]; }
      }
      if (L.leaky) for (let i = 0; i < out.length; i++) { const v = out[i]; if (v < 0) out[i] = 0.1 * v; }
      return { d: out, C: n, H: Ho, W: Wo };
    }

    function maxpool(x, C, H, W, L) {
      const k = L.k, s = L.s, Ho = Math.ceil(H / s), Wo = Math.ceil(W / s);
      const out = new Float32Array(C * Ho * Wo);
      for (let c = 0; c < C; c++)
        for (let oy = 0; oy < Ho; oy++) for (let ox = 0; ox < Wo; ox++) {
          let m = -1e9;
          for (let ky = 0; ky < k; ky++) { const y = oy * s + ky; if (y >= H) continue;
            for (let kx = 0; kx < k; kx++) { const xx = ox * s + kx; if (xx >= W) continue;
              const v = x[c * H * W + y * W + xx]; if (v > m) m = v; } }
          out[c * Ho * Wo + oy * Wo + ox] = m;
        }
      return { d: out, C, H: Ho, W: Wo };
    }

    function forward(img, size) { // img: Float32Array CHW 0..1, size x size
      const outs = [], yolos = [];
      let cur = { d: img, C: 3, H: size, W: size };
      layers.forEach((L, idx) => {
        if (L.t === 'convolutional') cur = conv(cur.d, cur.C, cur.H, cur.W, L);
        else if (L.t === 'maxpool') cur = maxpool(cur.d, cur.C, cur.H, cur.W, L);
        else if (L.t === 'route') {
          const parts = L.layers.map((l) => outs[l]);
          if (L.groups > 1) {
            const p = parts[0], c = p.C / L.groups, sz = p.H * p.W;
            cur = { d: p.d.subarray(L.gid * c * sz, (L.gid + 1) * c * sz), C: c, H: p.H, W: p.W };
          } else {
            let C = 0; parts.forEach((p) => { C += p.C; });
            const d = new Float32Array(C * parts[0].H * parts[0].W); let o = 0;
            parts.forEach((p) => { d.set(p.d, o); o += p.d.length; });
            cur = { d, C, H: parts[0].H, W: parts[0].W };
          }
        } else if (L.t === 'upsample') {
          const s = L.s, H = cur.H * s, W = cur.W * s, d = new Float32Array(cur.C * H * W);
          for (let c = 0; c < cur.C; c++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
            d[c * H * W + y * W + x] = cur.d[c * cur.H * cur.W + ((y / s) | 0) * cur.W + ((x / s) | 0)];
          cur = { d, C: cur.C, H, W };
        } else if (L.t === 'yolo') yolos.push({ o: cur, L });
        outs[idx] = cur;
      });
      return yolos;
    }

    /* img: {data: RGBA, width, height}. Il riquadro viene ridimensionato in modo che il lato lungo
       sia `size`, appoggiato in alto a sinistra su fondo grigio (come in addestramento). */
    function detect(img, opt) {
      opt = opt || {};
      const size = opt.size || netw, conf = opt.conf == null ? 0.15 : opt.conf, cls = opt.cls == null ? BALL : opt.cls;
      const iw = img.width, ih = img.height, sc = size / Math.max(iw, ih);
      const rw = Math.max(1, Math.round(iw * sc)), rh = Math.max(1, Math.round(ih * sc));
      const plane = size * size, x = new Float32Array(3 * plane).fill(127 / 255);
      for (let y = 0; y < rh; y++) {
        const fy = Math.min(ih - 1, Math.max(0, (y + 0.5) / sc - 0.5)), y0 = Math.floor(fy), y1 = Math.min(ih - 1, y0 + 1), ay = fy - y0;
        for (let xx = 0; xx < rw; xx++) {
          const fx = Math.min(iw - 1, Math.max(0, (xx + 0.5) / sc - 0.5)), x0 = Math.floor(fx), x1 = Math.min(iw - 1, x0 + 1), ax = fx - x0;
          for (let c = 0; c < 3; c++) {
            const a = img.data[(y0 * iw + x0) * 4 + c], b = img.data[(y0 * iw + x1) * 4 + c];
            const d = img.data[(y1 * iw + x0) * 4 + c], e = img.data[(y1 * iw + x1) * 4 + c];
            x[c * plane + y * size + xx] = ((a * (1 - ax) + b * ax) * (1 - ay) + (d * (1 - ax) + e * ax) * ay) / 255;
          }
        }
      }
      const res = [], sig = (v) => 1 / (1 + Math.exp(-v));
      forward(x, size).forEach(({ o, L }) => {
        const nc = L.classes, na = L.anchors.length, H = o.H, W = o.W, sxy = L.sxy, per = 5 + nc;
        for (let a = 0; a < na; a++) for (let gy = 0; gy < H; gy++) for (let gx = 0; gx < W; gx++) {
          const at = (ch) => o.d[(a * per + ch) * H * W + gy * W + gx];
          const s = sig(at(4)) * sig(at(5 + cls));
          if (s < conf) continue;
          const bx = (sig(at(0)) * sxy - 0.5 * (sxy - 1) + gx) / W * size, by = (sig(at(1)) * sxy - 0.5 * (sxy - 1) + gy) / H * size;
          const bw = Math.exp(at(2)) * L.anchors[a][0] / netw * size, bh = Math.exp(at(3)) * L.anchors[a][1] / neth * size;
          res.push({ x: bx / sc, y: by / sc, w: bw / sc, h: bh / sc, score: s });
        }
      });
      res.sort((p, q) => q.score - p.score);
      const keep = [];
      for (const r of res) if (keep.every((k) => Math.hypot(r.x - k.x, r.y - k.y) > 0.5 * Math.max((r.w + r.h) / 2, (k.w + k.h) / 2))) keep.push(r);
      return keep;
    }
    return { detect, forward };
  }

  const api = { create, BALL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Darknet = api;
})(typeof self !== 'undefined' ? self : this);
