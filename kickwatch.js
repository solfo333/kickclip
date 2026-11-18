/* KickClip – kickwatch.js: riconosce il calcio DAL VIDEO (niente microfono).
   Si "arma" sul pallone fermo (posizione data da behind.js) e guarda la zona attorno al pallone:
   il calcio è un cambiamento improvviso (arriva la gamba, il pallone parte), non una deriva lenta di luce e ombre.
   Uso: const kw = new KickWatch(w, h);  kw.arm({x, y, d}, k);  // x,y,d in coordinate 585 px, k = w/585
        const ev = kw.push(grigio, t);   // ev = {t} quando scatta il calcio, altrimenti null */
(function (root) {
  'use strict';
  function KickWatch(w, h) { this.w = w; this.h = h; this.reset(); }
  KickWatch.prototype.reset = function () { this.box = null; this.base = null; this.hist = []; this.times = []; };
  KickWatch.prototype.armed = function () { return !!this.box; };
  KickWatch.prototype.arm = function (rest, k) {
    const cx = rest.x * k, cy = rest.y * k, d = Math.max(6, rest.d * k), r = Math.max(6, Math.ceil(0.9 * d) + 2);
    this.box = { x0: Math.max(0, Math.round(cx - r)), y0: Math.max(0, Math.round(cy - r)),
      x1: Math.min(this.w, Math.round(cx + r)), y1: Math.min(this.h, Math.round(cy + r)) };
    this.base = null; this.hist = []; this.times = [];
  };
  KickWatch.prototype.patch = function (g) {
    const b = this.box, out = new Float32Array((b.x1 - b.x0) * (b.y1 - b.y0)); let k = 0;
    for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) out[k++] = g[y * this.w + x];
    return out;
  };
  KickWatch.prototype.push = function (g, t) {
    if (!this.box) return null;
    const p = this.patch(g);
    if (!this.base) { this.base = p; }
    let s = 0; for (let i = 0; i < p.length; i++) s += Math.abs(p[i] - this.base[i]);
    const diff = s / p.length;
    // il riferimento segue lentamente luce e ombre, ma solo quando la zona è calma
    if (diff < 6) for (let i = 0; i < p.length; i++) this.base[i] = 0.9 * this.base[i] + 0.1 * p[i];
    this.hist.push(diff); this.times.push(t);
    if (this.hist.length > 12) { this.hist.shift(); this.times.shift(); }
    const n = this.hist.length;
    if (n < 5) return null;
    const before = Math.max(this.hist[n - 4], this.hist[n - 5], n > 5 ? this.hist[n - 6] : 0);
    if (this.hist[n - 2] > before + 8 && this.hist[n - 1] > before + 8 && this.hist[n - 2] > 14) return { t: this.times[n - 2], diff: this.hist[n - 2] };
    return null;
  };
  const api = { KickWatch };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.KickWatch = KickWatch;
})(typeof self !== 'undefined' ? self : this);
