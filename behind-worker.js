/* KickClip – behind-worker.js: analisi dei tiri ripresi da dietro (rilevatore di pallone + tracciamento) */
importScripts('darknet.js', 'behind.js');

let net = null, cancelFlag = false, nextReq = 0;
const waiting = new Map();

async function loadNet() {
  if (net) return net;
  const [spec, bin] = await Promise.all([
    fetch('yolo.json').then(r => { if (!r.ok) throw new Error('modello mancante (yolo.json)'); return r.json(); }),
    fetch('yolo.bin').then(r => { if (!r.ok) throw new Error('modello mancante (yolo.bin)'); return r.arrayBuffer(); })
  ]);
  net = self.Darknet.create(spec, bin);
  return net;
}

// i fotogrammi li decodifica il thread principale (qui non c'è un canvas affidabile su tutti i telefoni)
function getFrame(i) {
  return new Promise(resolve => {
    const id = ++nextReq;
    waiting.set(id, resolve);
    self.postMessage({ type: 'frame', id, i });
  });
}

self.onmessage = async ev => {
  const m = ev.data;
  if (m.type === 'frame') {
    const r = waiting.get(m.id);
    if (r) { waiting.delete(m.id); r({ data: new Uint8ClampedArray(m.buf), width: m.width, height: m.height }); }
  } else if (m.type === 'cancel') {
    cancelFlag = true;
  } else if (m.type === 'run') {
    cancelFlag = false;
    try {
      self.postMessage({ type: 'progress', text: 'Carico il modello (solo la prima volta è lento)…', p: 0.01 });
      const n = await loadNet();
      const result = await self.KickBehind.analyzeBehind({
        getFrame, times: m.times, net: n, maxFlight: 12,
        cancelled: () => cancelFlag,
        onProgress: (text, p) => self.postMessage({ type: 'progress', text, p })
      });
      self.postMessage({ type: 'done', result });
    } catch (e) {
      self.postMessage({ type: 'done', result: { ok: false, reason: 'analisi da dietro non riuscita: ' + e.message } });
    }
  }
};
