'use strict';

// Runs in the real honeybee window ahead of app.js, for the promo video only.
// The window's state, its clock and its once-a-second tick come from the
// stage (promo/stage.js) instead of the app, so every frame can be drawn on
// demand and comes out the same each time.

(() => {
  const stage = window.parent.stage;
  const listeners = [];
  const done = () => Promise.resolve({ ok: true });
  window.honeybee = {
    getState: () => Promise.resolve(stage.widgetState()),
    onState: (callback) => {
      listeners.push(callback);
      return () => {};
    },
    connect: done,
    disconnect: done,
    dismiss: done,
    setSetting: done,
    retryServer: done,
    checkUpdate: done,
    openExternal: done,
    showFile: done,
    window: () => {}
  };
  Date.now = () => stage.clock();
  window.setInterval = (fn) => {
    stage.ticks.push(fn);
    return 0;
  };
  // An offscreen page can count as hidden, and the machine rendering the
  // video may ask for less motion: the window should look as it does on a
  // desktop either way.
  Object.defineProperty(document, 'hidden', { get: () => false });
  const matchMedia = window.matchMedia.bind(window);
  window.matchMedia = (query) => (/reduced-motion/.test(query)
    ? { matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }
    : matchMedia(query));
  stage.widget = { push: (state) => listeners.forEach((callback) => callback(state)), document };
})();
