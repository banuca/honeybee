'use strict';

// The fold: a snapshot of the window shrinks into the bubble's place while a
// stand-in hexagon grows there. The main process swaps the real window for
// the snapshot before anything moves, and the real bubble for the stand-in
// once it has landed.

const snapshot = document.getElementById('snapshot');
const standin = document.getElementById('standin');
const count = document.getElementById('count');
let plan = null;

function place(el, r) {
  el.style.left = `${r.x}px`;
  el.style.top = `${r.y}px`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
}

// The bubble's look for these counts, as bubble.js draws it.
function look(counts) {
  if (counts['needs-you'] > 0) return { state: 'needs', text: String(counts['needs-you']) };
  if (counts.working > 0) return { state: 'working', text: String(counts.working) };
  return { state: 'idle', text: '' };
}

// The snapshot covers the window exactly, so the window can go once the
// snapshot is really on screen. Element Timing reports that moment (when
// the frame with the image was presented, not merely drawn); if it never
// comes, carry on after a short wait.
function onScreen(timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { observer.disconnect(); resolve(false); }, timeout);
    const observer = new PerformanceObserver((list) => {
      if (!list.getEntries().some((e) => e.identifier === 'snapshot')) return;
      clearTimeout(timer);
      observer.disconnect();
      resolve(true);
    });
    observer.observe({ type: 'element', buffered: true });
  });
}

window.foldApi.onPlay(async (p) => {
  plan = p;
  place(snapshot, p.from);
  snapshot.style.borderRadius = `${p.radius}px`;
  if (p.counts) {
    const { state, text } = look(p.counts);
    standin.dataset.state = state;
    count.textContent = text;
    standin.style.left = `${p.to.x}px`;
    standin.style.top = `${p.to.y}px`;
  }
  snapshot.src = p.image;
  try { await snapshot.decode(); } catch (_) { /* drawn as it is */ }
  const presented = onScreen(500);
  snapshot.classList.add('ready');
  if (!(await presented)) window.foldApi.say('late');
  window.foldApi.say('shown');
});

window.foldApi.onGo(() => {
  const p = plan;
  const dx = (p.to.x + p.to.width / 2) - (p.from.x + p.from.width / 2);
  const dy = (p.to.y + p.to.height / 2) - (p.from.y + p.from.height / 2);
  const scale = Math.min(p.to.width / p.from.width, p.to.height / p.from.height);
  // The window glides the whole way, easing off and on, and only fades as it
  // reaches the bubble, which grows up out of it.
  const moves = [
    snapshot.animate([
      { transform: 'none' },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})` }
    ], { duration: p.ms, easing: 'cubic-bezier(0.45, 0, 0.4, 1)', fill: 'forwards' }),
    snapshot.animate([
      { opacity: 1 },
      { opacity: 1, offset: 0.6 },
      { opacity: 0 }
    ], { duration: p.ms, fill: 'forwards' })
  ];
  if (p.counts) {
    moves.push(standin.animate([
      { opacity: 0, transform: 'scale(0.6)' },
      { opacity: 0, transform: 'scale(0.6)', offset: 0.6 },
      { opacity: 1, transform: 'scale(1.08)', offset: 0.88 },
      { opacity: 1, transform: 'scale(1)' }
    ], { duration: p.ms + 60, easing: 'ease-out', fill: 'forwards' }));
  }
  Promise.all(moves.map((m) => m.finished)).then(() => window.foldApi.say('landed'));
});
