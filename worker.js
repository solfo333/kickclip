/* KickClip – worker.js: esegue l'analisi dei tiri fuori dal thread principale */
importScripts('analysis.js');

self.onmessage = function (ev) {
  const { id, opts } = ev.data;
  let result;
  try {
    result = self.KickAnalysis.analyzeClip(opts);
  } catch (e) {
    result = { ok: false, reason: 'errore analisi: ' + e.message };
  }
  self.postMessage({ id, result });
};
