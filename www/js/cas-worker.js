// Motor de cálculo (Giac) en un hilo aparte: así un cálculo largo nunca congela la app
// y, si se pasa del tiempo, se puede cortar y empezar de nuevo.
self.window = self;
self.innerWidth = 1080;
const noop = () => {};
const fake = () => ({ style: {}, getContext: () => null, appendChild: noop, addEventListener: noop, setAttribute: noop });
self.document = {
  currentScript: null, title: '', body: fake(),
  getElementById: () => null, querySelector: () => null, createElement: fake,
  addEventListener: noop, removeEventListener: noop,
};

let caseval = null;
// Giac avisa los errores con alert(): se guardan para devolverlos como texto.
let alertMsg = '';
self.alert = m => { alertMsg += (alertMsg ? ' ' : '') + String(m); };
const ready = (async () => {
  const M = (await import('../vendor/giac/giac.js')).default;
  M.print = noop; M.printErr = noop;
  await new Promise(r => {
    if (M.calledRun) r();
    else { const o = M.onRuntimeInitialized; M.onRuntimeInitialized = () => { o && o(); r(); }; }
  });
  caseval = M.cwrap('caseval', 'string', ['string']);
  // Resultados exactos (sin el decimal pegado) y en radianes.
  for (const c of ['angle_radian:=1', 'complex_mode:=0']) { try { caseval(c); } catch {} }
})();

self.onmessage = async e => {
  const { id, cmds } = e.data;
  try {
    await ready;
    const out = [];
    for (const c of cmds) {
      let r;
      alertMsg = '';
      try { r = caseval(c); } catch (err) { r = 'GIAC_ERROR: ' + (err && err.message || err); }
      if (alertMsg) r = 'GIAC_ERROR: ' + alertMsg;
      out.push(r);
    }
    self.postMessage({ id, out });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
