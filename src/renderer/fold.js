'use strict';

// The fold: a snapshot of the window shrinks into a bee, which flies down to
// the hive (a stand-in for the bubble) and dives in. The main process swaps
// the real window for the snapshot before anything moves, and the real
// bubble for the stand-in once the bee is home.

const snapshot = document.getElementById('snapshot');
const standin = document.getElementById('standin');
const count = document.getElementById('count');
const bee = document.getElementById('bee');
const beeArt = document.getElementById('bee-art');
const BEE = 34;
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
  snapshot.src = typeof p.image === 'string' ? p.image : URL.createObjectURL(new Blob([p.image], { type: 'image/bmp' }));
  try { await snapshot.decode(); } catch (_) { /* drawn as it is */ }
  const presented = onScreen(500);
  snapshot.classList.add('ready');
  if (!(await presented)) window.foldApi.say('late');
  window.foldApi.say('shown');
});

const centre = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// The bee's way home: a hop up, then an arc that comes down on the hive
// from above, wobbling a little, and never leaving the layer.
function flightPath(a, b, steps = 32) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const p1 = { x: a.x, y: a.y - Math.min(90, 30 + dist * 0.3) };
  const p2 = { x: b.x - (b.x - a.x) * 0.2, y: b.y - Math.max(70, Math.abs(b.y - a.y) * 0.4) };
  const at = (t) => {
    const u = 1 - t;
    return {
      x: u * u * u * a.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * b.y
    };
  };
  const edge = BEE / 2 + 2;
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const here = at(t);
    const ahead = at(Math.min(1, t + 0.01));
    const behind = at(Math.max(0, t - 0.01));
    const len = Math.hypot(ahead.x - behind.x, ahead.y - behind.y) || 1;
    // Across the line of flight, fading out at take-off and landing.
    const wobble = 6 * Math.sin(t * Math.PI * 5) * Math.sin(t * Math.PI);
    points.push({
      x: clamp(here.x - ((ahead.y - behind.y) / len) * wobble, edge, window.innerWidth - edge),
      y: clamp(here.y + ((ahead.x - behind.x) / len) * wobble, edge, window.innerHeight - edge)
    });
  }
  return points;
}

// One keyframe per point, the bee turned towards where it is heading. It is
// drawn facing right, so it is mirrored once if the hive lies to the left.
function flightFrames(points, mirrored) {
  const limit = 40;
  return points.map((pt, i) => {
    const next = points[Math.min(points.length - 1, i + 1)];
    const prev = points[Math.max(0, i - 1)];
    const vx = next.x - prev.x;
    const vy = next.y - prev.y;
    const angle = (mirrored ? Math.atan2(-vy, -vx) : Math.atan2(vy, vx)) * 180 / Math.PI;
    return {
      transform: `translate(${pt.x - BEE / 2}px, ${pt.y - BEE / 2}px) rotate(${clamp(angle, -limit, limit)}deg) scaleX(${mirrored ? -1 : 1})`
    };
  });
}

// The window becomes a bee where it stands, the hive appears in its corner,
// and the bee flies home and dives in. Shares of the whole time, p.ms.
function beeHome(p) {
  const T = p.ms;
  const from = centre(p.from);
  const home = centre(p.to);
  const moves = [
    snapshot.animate([
      { transform: 'none' },
      { transform: 'scale(0.06)' }
    ], { duration: T * 0.22, easing: 'cubic-bezier(0.55, 0, 0.75, 0.2)', fill: 'forwards' }),
    snapshot.animate([
      { opacity: 1 },
      { opacity: 1, offset: 0.5 },
      { opacity: 0 }
    ], { duration: T * 0.22, fill: 'forwards' }),
    standin.animate([
      { opacity: 0, transform: 'scale(0.85)', offset: 0 },
      { opacity: 0, transform: 'scale(0.85)', offset: 0.12 },
      { opacity: 1, transform: 'scale(1)', offset: 0.34 },
      { opacity: 1, transform: 'scale(1)', offset: 0.86 },
      { opacity: 1, transform: 'scale(1.12)', offset: 0.93 },
      { opacity: 1, transform: 'scale(1)', offset: 1 }
    ], { duration: T, fill: 'forwards' }),
    beeArt.animate([
      { opacity: 0, transform: 'scale(0.3)', offset: 0 },
      { opacity: 0, transform: 'scale(0.3)', offset: 0.12 },
      { opacity: 1, transform: 'scale(1.15)', offset: 0.22 },
      { opacity: 1, transform: 'scale(1)', offset: 0.28 },
      { opacity: 1, transform: 'scale(1)', offset: 0.86 },
      { opacity: 0, transform: 'scale(0.2)', offset: 1 }
    ], { duration: T, fill: 'forwards' }),
    bee.animate(flightFrames(flightPath(from, home), home.x < from.x), {
      delay: T * 0.24,
      duration: T * 0.62,
      easing: 'cubic-bezier(0.35, 0, 0.25, 1)',
      fill: 'both'
    })
  ];
  bee.classList.add('flying');
  return moves;
}

// The bubble is on another screen, out of reach: the window just shrinks
// away into its own centre.
function shrinkAway(p) {
  const scale = Math.min(p.to.width / p.from.width, p.to.height / p.from.height);
  return [
    snapshot.animate([
      { transform: 'none' },
      { transform: `scale(${scale})` }
    ], { duration: p.ms * 0.45, easing: 'cubic-bezier(0.45, 0, 0.4, 1)', fill: 'forwards' }),
    snapshot.animate([
      { opacity: 1 },
      { opacity: 1, offset: 0.6 },
      { opacity: 0 }
    ], { duration: p.ms * 0.45, fill: 'forwards' })
  ];
}

window.foldApi.onGo(() => {
  const moves = plan.counts ? beeHome(plan) : shrinkAway(plan);
  // A reset cancels the animations, which rejects `finished`: nothing to say then.
  Promise.all(moves.map((m) => m.finished)).then(() => window.foldApi.say('landed'), () => {});
});

// Back to empty, for the next time.
window.foldApi.onReset(() => {
  for (const a of document.getAnimations()) a.cancel();
  bee.classList.remove('flying');
  snapshot.classList.remove('ready');
  if (snapshot.src.startsWith('blob:')) URL.revokeObjectURL(snapshot.src);
  snapshot.removeAttribute('src');
  plan = null;
});

// The other way: the bee pops out of the hive, flies to where the window
// lives, and the window opens there as the bee arrives and fades into it.
window.foldApi.onUnfold((p) => {
  const T = p.ms;
  const hive = centre(p.hive);
  const home = centre(p.window);
  bee.classList.add('flying');
  beeArt.animate([
    { opacity: 0, transform: 'scale(0.2)', offset: 0 },
    { opacity: 1, transform: 'scale(1.15)', offset: 0.12 },
    { opacity: 1, transform: 'scale(1)', offset: 0.18 },
    { opacity: 1, transform: 'scale(1)', offset: 0.84 },
    { opacity: 0, transform: 'scale(0.3)', offset: 1 }
  ], { duration: T, fill: 'forwards' }).finished.then(() => window.foldApi.say('landed'), () => {});
  bee.animate(flightFrames(flightPath(hive, home), home.x < hive.x), {
    delay: T * 0.1,
    duration: T * 0.72,
    easing: 'cubic-bezier(0.35, 0, 0.25, 1)',
    fill: 'both'
  }).finished.then(() => window.foldApi.say('arrived'), () => {});
});
