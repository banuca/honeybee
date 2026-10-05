'use strict';

// The promo video: a 1280×720 scene drawn as a pure function of time. seek(t)
// puts everything where it belongs t seconds in, and promo/render.js steps
// through it frame by frame. The window in the middle is the real honeybee
// window (src/renderer), fed a made-up afternoon through widget-shim.js.
//
// The story: the title; a bee dives into the logo, which opens out into the
// window; sessions arrive and one needs you; the limits drain; ✕ folds the
// window into the bee, which flies home to the hive; the hive turns back into
// the logo, so the loop joins up.

const DURATION = 21;
const WIN = { w: 720, h: 480 }; // the honeybee window, in CSS pixels
const LOGO = 120; // the hexagon's box on the title
const HIVE = { x: 1170, y: 612, size: 96 };
const BEE = 34; // fold.css's bee

// When things happen, in seconds.
const AT = {
  beeIn: 0.3, beeHome: 1.2, // the bee flies into the logo
  titleOut: 1.45,
  toCentre: 1.55, reveal: 2.05, revealed: 2.7, // the logo opens into the window
  ship: 3.3, fix: 3.9, ask: 5.1, fixed: 6.6, // sessions
  toastIn: 5.15, toastOut: 7.7,
  toUsage: 8.2, drain: 9.2,
  toFold: 12.2, cursorIn: 12.85, click: 13.85,
  fold: 14.1, foldFor: 1.5, // fold.js's choreography, a little slower than the app's 920 ms
  homeward: 16.35, type: 17.3, endIn: 17.85, endOut: 20.05, taglineIn: 20.4
};

const CAPTIONS = [
  ['cap-agents', 3.0, 4.95],
  ['cap-nudge', 5.25, 7.95],
  ['cap-comb', 8.75, 12.15],
  ['cap-bee', 13.95, 16.25]
];

// ---- easing --------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, k) => a + (b - a) * k;
const linear = (k) => k;
const easeIn = (k) => k ** 3;
const easeOut = (k) => 1 - (1 - k) ** 3;
const easeInOut = (k) => (k < 0.5 ? 4 * k ** 3 : 1 - ((2 - 2 * k) ** 3) / 2);
const backOut = (k) => 1 + 2.4 * (k - 1) ** 3 + 1.4 * (k - 1) ** 2;

/** How far t is through [a, b], eased: 0 before a, 1 after b. */
const prog = (t, a, b, ease = linear) => ease(clamp((t - a) / (b - a), 0, 1));

/** The value at t on [[time, value], …], eased between neighbouring stops. */
function track(t, stops, ease = easeInOut) {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i += 1) {
    const [t1, v1] = stops[i];
    if (t <= t1) {
      const [t0, v0] = stops[i - 1];
      return lerp(v0, v1, ease((t - t0) / (t1 - t0)));
    }
  }
  return stops[stops.length - 1][1];
}

/** CSS's cubic-bezier(), so the fold keeps fold.js's curves. */
function bezier(x1, y1, x2, y2) {
  const curve = (a, b, s) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 32; i += 1) {
      const mid = (lo + hi) / 2;
      if (curve(x1, x2, mid) < x) lo = mid;
      else hi = mid;
    }
    return curve(y1, y2, (lo + hi) / 2);
  };
}
const SHRINK = bezier(0.55, 0, 0.75, 0.2);
const FLIGHT = bezier(0.35, 0, 0.25, 1);

// ---- the bee's flight (fold.js) ---------------------------------------------------

// A hop up, then an arc that comes down on the target from above, wobbling a
// little, the bee turned towards where it is heading. Both flights here go
// left to right, so the bee is never mirrored.
function flightPath(a, b, size, steps = 32) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const p1 = { x: a.x, y: a.y - Math.min(90, 30 + dist * 0.3) * size };
  const p2 = { x: b.x - (b.x - a.x) * 0.2, y: b.y - Math.max(70 * size, Math.abs(b.y - a.y) * 0.4) };
  const at = (t) => {
    const u = 1 - t;
    return {
      x: u * u * u * a.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * b.y
    };
  };
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const here = at(t);
    const ahead = at(Math.min(1, t + 0.01));
    const behind = at(Math.max(0, t - 0.01));
    const len = Math.hypot(ahead.x - behind.x, ahead.y - behind.y) || 1;
    const wobble = 6 * size * Math.sin(t * Math.PI * 5) * Math.sin(t * Math.PI);
    points.push({
      x: here.x - ((ahead.y - behind.y) / len) * wobble,
      y: here.y + ((ahead.x - behind.x) / len) * wobble
    });
  }
  return points.map((pt, i) => {
    const next = points[Math.min(points.length - 1, i + 1)];
    const prev = points[Math.max(0, i - 1)];
    return { ...pt, angle: clamp(Math.atan2(next.y - prev.y, next.x - prev.x) * 180 / Math.PI, -40, 40) };
  });
}

/** Where on a flight path the bee is at k, from 0 to 1. */
function along(path, k) {
  const f = clamp(k, 0, 1) * (path.length - 1);
  const i = Math.min(path.length - 2, Math.floor(f));
  const r = f - i;
  return {
    x: lerp(path[i].x, path[i + 1].x, r),
    y: lerp(path[i].y, path[i + 1].y, r),
    angle: lerp(path[i].angle, path[i + 1].angle, r)
  };
}

// ---- the camera -------------------------------------------------------------------

// A pose puts the window's point (fx, fy) at the stage's point (ax, ay), at
// scale s.
const POSE = {
  reveal: { fx: 360, fy: 240, ax: 640, ay: 330, s: 1.2 },
  agents: { fx: 300, fy: 236, ax: 604, ay: 334, s: 1.36 },
  usage: { fx: 575, fy: 190, ax: 655, ay: 318, s: 2.05 },
  fold: { fx: 360, fy: 240, ax: 560, ay: 336, s: 1.08 }
};
const CAMERA = [
  [0, POSE.reveal],
  [3.0, POSE.reveal],
  [4.1, POSE.agents],
  [AT.toUsage, POSE.agents],
  [AT.toUsage + 0.95, POSE.usage],
  [AT.toFold, POSE.usage],
  [AT.toFold + 0.8, POSE.fold]
];

function camera(t) {
  let i = 1;
  while (i < CAMERA.length && t >= CAMERA[i][0]) i += 1;
  if (i >= CAMERA.length) return CAMERA[CAMERA.length - 1][1];
  const [t0, a] = CAMERA[i - 1];
  const [t1, b] = CAMERA[i];
  const k = easeInOut(clamp((t - t0) / (t1 - t0), 0, 1));
  return {
    fx: lerp(a.fx, b.fx, k),
    fy: lerp(a.fy, b.fy, k),
    ax: lerp(a.ax, b.ax, k),
    ay: lerp(a.ay, b.ay, k),
    s: a.s * (b.s / a.s) ** k // zooms at an even pace
  };
}

const toStage = (p, x, y) => ({ x: p.ax + (x - p.fx) * p.s, y: p.ay + (y - p.fy) * p.s });

function hexPoints(cx, cy, r) {
  const points = [];
  for (let i = 0; i < 6; i += 1) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return points;
}

// ---- the window's afternoon ------------------------------------------------------------

// The window's clock: a Friday afternoon, the same on every render.
const T0 = new Date(2026, 9, 2, 14, 3, 0).getTime();
const clockAt = (t) => T0 + t * 1000;
const MIN = 60e3;
const URGENCY = { 'needs-you': 0, failed: 1, working: 2, done: 3, stopped: 3, idle: 4 };

function session(key, agent, title, project, status, since, extra = {}) {
  return { key, agent, title, project, status, statusSince: since, updatedAt: since, ...extra };
}

function sessionsAt(t) {
  const list = [
    session('claude:parser', 'claude', 'Refactor the rollout parser', 'parser', 'working', T0 - 6.5 * MIN),
    session('codex:site', 'codex', 'Make the landing page responsive', 'site', 'working', T0 - 13 * MIN),
    session('codex:articles', 'codex', 'Rename the article files', 'site', 'done', T0 - 22 * MIN, { lastMessage: 'Renamed five files.' }),
    session('claude:shop', 'claude', 'Tidy the stylesheet', 'shop', 'done', T0 - 48 * MIN, { lastMessage: 'Done.' })
  ];
  if (t >= AT.ship) {
    list.push(t < AT.ask
      ? session('claude:ship', 'claude', 'Ship the widget', 'honeybee', 'working', clockAt(AT.ship))
      : session('claude:ship', 'claude', 'Ship the widget', 'honeybee', 'needs-you', clockAt(AT.ask), { reason: 'approve a command' }));
  }
  if (t >= AT.fix) {
    list.push(t < AT.fixed
      ? session('claude:checkout', 'claude', 'Fix the flaky checkout test', 'checkout', 'working', clockAt(AT.fix))
      : session('claude:checkout', 'claude', 'Fix the flaky checkout test', 'checkout', 'done', clockAt(AT.fixed), { lastMessage: 'All 214 tests pass.' }));
  }
  return list.sort((a, b) => (URGENCY[a.status] - URGENCY[b.status]) || (b.statusSince - a.statusSince));
}

const RESETS = {
  claude5: T0 + (2 * 60 + 9.5) * MIN,
  claudeWeek: new Date(2026, 9, 4, 20, 12).getTime(),
  codex5: T0 + (2 * 60 + 59.5) * MIN,
  codexWeek: new Date(2026, 9, 5, 20, 12).getTime()
};

function usageAt(t) {
  const left = (from, to, a, b) => Math.round(lerp(from, to, prog(t, a, b, easeInOut)));
  const meter = (label, leftPercent, resetsAt) => {
    const used = 100 - leftPercent;
    const level = used >= 95 ? 'critical' : used >= 80 ? 'warn' : 'ok'; // usage.js's levels
    return { label, usedPercent: used, leftPercent, resetsAt, reset: false, level, observedAt: T0 };
  };
  return {
    claude: {
      observedAt: T0,
      windows: [
        meter('5-hour', left(86, 58, AT.drain, AT.drain + 2.3), RESETS.claude5),
        meter('weekly', left(31, 17, AT.drain + 0.2, AT.drain + 2.5), RESETS.claudeWeek)
      ]
    },
    codex: {
      observedAt: T0,
      plan: 'plus',
      reached: false,
      windows: [
        meter('5-hour', left(93, 89, AT.drain + 0.5, AT.drain + 2.5), RESETS.codex5),
        meter('weekly', 80, RESETS.codexWeek)
      ]
    }
  };
}

const CONNECTED = { connected: true, present: true, check: {}, hookSeenAt: T0 - 4000 };

// The whole state, shaped like the main process's snapshot (src/main/app.js).
function widgetState(t) {
  const agents = sessionsAt(t);
  const counts = { 'needs-you': 0, working: 0, done: 0, stopped: 0, failed: 0, idle: 0, total: 0 };
  for (const s of agents) {
    counts[s.status] += 1;
    counts.total += 1;
  }
  return {
    version: stage.version,
    platform: 'win32',
    locale: 'en-GB',
    now: clockAt(t),
    agents,
    counts,
    usage: usageAt(t),
    integrations: { claude: CONNECTED, codex: CONNECTED },
    server: { port: 47621, listening: true, error: null },
    settings: {
      theme: 'system', alwaysOnTop: false, bubbleOnClose: true, notifyNeedsYou: true, notifyDone: true,
      notifySound: false, launchAtLogin: false, view: 'agents', zoom: 1, split: null
    },
    update: null,
    seen: {}
  };
}

// ---- the stage ------------------------------------------------------------------------

const stage = {
  t: 0,
  ticks: [], // app.js's once-a-second tick, handed over by widget-shim.js
  widget: null, // set by widget-shim.js
  version: '',
  clock: () => clockAt(stage.t),
  widgetState: () => widgetState(stage.t),
  seek,
  ready: null
};
window.stage = stage;

const $ = (id) => document.getElementById(id);
const els = {};
const L = {}; // positions measured once everything has loaded

function layout() {
  // The title: the hexagon and the wordmark, centred together.
  const width = $('wordmark-text').getBoundingClientRect().width;
  L.char = width / 'honeybee'.length;
  const half = ((51.9 - 12.1) / 2 / 64) * LOGO; // the hexagon's half-width
  const gap = 30;
  L.logo = { x: 640 - (half * 2 + gap + width) / 2 + half, y: 300 };
  L.wordmark = { x: L.logo.x + half + gap, y: L.logo.y - 41 };
  // Where the camera holds the window for the fold.
  const button = stage.widget.close.getBoundingClientRect();
  L.close = toStage(POSE.fold, button.left + button.width / 2, button.top + button.height / 2);
  L.centre = toStage(POSE.fold, WIN.w / 2, WIN.h / 2);
  L.introPath = flightPath({ x: -70, y: 540 }, L.logo, 1.9);
  L.homePath = flightPath(L.centre, HIVE, 1.5);
}

// ---- drawing --------------------------------------------------------------------------

let lastSignature = null;
let lastSecond = null;

function drawWidget(t) {
  const w = stage.widget;
  const state = widgetState(t);
  const signature = JSON.stringify([state.agents, state.usage]);
  if (signature !== lastSignature) {
    lastSignature = signature;
    w.push(state);
  }
  const second = Math.floor(t);
  if (second !== lastSecond) {
    lastSecond = second;
    for (const tick of stage.ticks) tick();
  }
  // A spotlight on whichever side the story is about.
  w.agents.style.opacity = track(t, [[AT.toUsage, 1], [AT.toUsage + 0.8, 0.4], [AT.toFold, 0.4], [AT.toFold + 0.7, 1]]);
  w.usage.style.opacity = track(t, [[3.0, 1], [4.0, 0.45], [AT.toUsage - 0.1, 0.45], [AT.toUsage + 0.6, 1]]);
  // The pointer over ✕ lights it as the app does (styles.css).
  const hover = t >= AT.click - 0.12 && t < AT.fold + 0.4;
  w.close.style.color = hover ? 'var(--honey)' : '';
  w.close.style.background = hover ? 'var(--surface-2)' : '';
}

function drawWindow(t) {
  const p = camera(t);
  // The fold: the window shrinks into its own centre and fades, as fold.js's
  // snapshot does, in the first 22% of the fold.
  const f = (t - AT.fold) / AT.foldFor;
  const shrink = f <= 0 ? 1 : lerp(1, 0.06, SHRINK(clamp(f / 0.22, 0, 1)));
  const fade = f <= 0 ? 1 : track(f / 0.22, [[0, 1], [0.5, 1], [1, 0]], linear);
  const shown = t >= AT.reveal && f < 0.22 ? fade : 0;
  const s = p.s * shrink;
  const x = p.ax - p.fx * p.s + ((1 - shrink) * WIN.w * p.s) / 2;
  const y = p.ay - p.fy * p.s + ((1 - shrink) * WIN.h * p.s) / 2;
  const transform = `translate(${x}px, ${y}px) scale(${s})`;
  els.window.style.transform = transform;
  els.window.style.opacity = shown;
  els.shadow.style.transform = transform;
  els.shadow.style.opacity = shown * prog(t, 2.35, 2.9);
  // The reveal: the window opens out of the logo through a growing hexagon.
  if (t < AT.revealed) {
    const r = lerp((23 / 64) * LOGO / POSE.reveal.s, 540, prog(t, AT.reveal, AT.revealed, easeInOut));
    const points = hexPoints(WIN.w / 2, WIN.h / 2, r).map(([px, py]) => `${px.toFixed(1)}px ${py.toFixed(1)}px`);
    els.window.style.clipPath = `polygon(${points.join(', ')})`;
  } else {
    els.window.style.clipPath = 'none';
  }
  els.glow.style.transform = `translate(${x + (WIN.w * s) / 2}px, ${y + (WIN.h * s) / 2}px)`;
  els.glow.style.opacity = shown * prog(t, AT.reveal, AT.revealed);
}

// A ring of honey that runs out from the logo as the window opens.
function drawRing(t) {
  const k = prog(t, AT.reveal, AT.reveal + 0.8, easeOut);
  const d = hexPoints(640, 330, lerp(43, 760, k)).map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
  els.ringPath.setAttribute('d', `${d}Z`);
  els.ring.style.opacity = track(t, [[AT.reveal, 0], [AT.reveal + 0.05, 0.9], [AT.reveal + 0.8, 0]], linear);
}

// The hexagon: the logo on the title, the hive after the fold, and the logo
// again at the end.
function hexAt(t) {
  if (t < AT.fold) {
    const k = prog(t, AT.toCentre, AT.reveal, easeInOut);
    const pulse = track(t, [[AT.beeHome, 1], [AT.beeHome + 0.12, 1.1], [AT.beeHome + 0.3, 1]]);
    const open = prog(t, AT.reveal, AT.reveal + 0.3, easeIn);
    return {
      x: lerp(L.logo.x, 640, k),
      y: lerp(L.logo.y, 330, k),
      size: LOGO * pulse * (1 + 0.35 * open),
      opacity: 1 - open,
      stripes: 1,
      count: 0,
      glow: 0
    };
  }
  if (t < AT.homeward) {
    // fold.js's stand-in, lit because a session needs you.
    const f = clamp((t - AT.fold) / AT.foldFor, 0, 1);
    const landed = t >= AT.fold + AT.foldFor * 0.93;
    return {
      x: HIVE.x,
      y: HIVE.y,
      size: HIVE.size * track(f, [[0.12, 0.85], [0.34, 1], [0.86, 1], [0.93, 1.12], [1, 1]], linear),
      opacity: track(f, [[0.12, 0], [0.34, 1]], linear),
      stripes: 0,
      count: 1,
      glow: landed ? 1 : 0
    };
  }
  const k = prog(t, AT.homeward, AT.homeward + 0.9, easeInOut);
  return {
    x: lerp(HIVE.x, L.logo.x, k),
    y: lerp(HIVE.y, L.logo.y, k),
    size: lerp(HIVE.size, LOGO, k),
    opacity: 1,
    stripes: prog(t, AT.homeward + 0.3, AT.homeward + 0.7),
    count: 1 - prog(t, AT.homeward, AT.homeward + 0.35),
    glow: 1 - prog(t, AT.homeward, AT.homeward + 0.5)
  };
}

function drawHive(t) {
  const h = hexAt(t);
  els.hive.style.transform = `translate(${h.x - h.size / 2}px, ${h.y - h.size / 2}px) scale(${h.size / 64})`;
  els.hive.style.opacity = h.opacity;
  els.stripes.style.opacity = h.stripes;
  els.count.style.opacity = h.count;
  els.hiveArt.style.filter = h.glow > 0 ? `drop-shadow(0 0 ${(7 * h.glow).toFixed(2)}px rgba(240, 169, 46, ${(0.75 * h.glow).toFixed(3)}))` : 'none';
  // A softer glow behind it, on the title and the end card.
  const behind = t < AT.fold ? 1 - prog(t, AT.toCentre, AT.reveal) : prog(t, AT.homeward, AT.homeward + 0.9);
  els.hexGlow.style.transform = `translate(${h.x}px, ${h.y}px)`;
  els.hexGlow.style.opacity = behind;
}

function drawBee(t) {
  let pose = null;
  if (t >= AT.beeIn && t < AT.beeHome + 0.2) {
    // Into the logo.
    const dive = prog(t, AT.beeHome, AT.beeHome + 0.16);
    pose = { ...along(L.introPath, FLIGHT(prog(t, AT.beeIn, AT.beeHome))), size: 1.9, opacity: 1 - dive, scale: lerp(1, 0.2, dive) };
  } else if (t >= AT.fold && t < AT.fold + AT.foldFor) {
    // Home to the hive, with fold.js's shares of the fold.
    const f = (t - AT.fold) / AT.foldFor;
    pose = {
      ...along(L.homePath, FLIGHT(clamp((f - 0.24) / 0.62, 0, 1))),
      size: 1.5,
      opacity: track(f, [[0.12, 0], [0.22, 1], [0.86, 1], [1, 0]], linear),
      scale: track(f, [[0.12, 0.3], [0.22, 1.15], [0.28, 1], [0.86, 1], [1, 0.2]], linear)
    };
  }
  if (!pose || pose.opacity <= 0) {
    els.bee.style.opacity = 0;
    return;
  }
  els.bee.style.opacity = 1;
  els.bee.style.transform = `translate(${pose.x - BEE / 2}px, ${pose.y - BEE / 2}px) rotate(${pose.angle}deg) scale(${pose.size})`;
  els.beeArt.style.opacity = pose.opacity;
  els.beeArt.style.transform = `scale(${pose.scale})`;
  // fold.css's flutter: 50 ms down, 50 ms up.
  const phase = (t % 0.1) / 0.1;
  els.wings.style.transform = `scaleY(${1 - 0.65 * (phase < 0.5 ? phase * 2 : 2 - phase * 2)})`;
}

function drawToast(t) {
  const into = prog(t, AT.toastIn, AT.toastIn + 0.5, backOut);
  const away = prog(t, AT.toastOut, AT.toastOut + 0.35, easeIn);
  els.toast.style.transform = `translate(${1280 - 380 - 28 + (1 - into) * 430 + away * 430}px, 28px)`;
  els.toast.style.opacity = t >= AT.toastIn && t < AT.toastOut + 0.35 ? 1 : 0;
}

function drawCursor(t) {
  const from = { x: 1065, y: 480 };
  const to = L.close;
  const via = { x: lerp(from.x, to.x, 0.2) + 60, y: lerp(from.y, to.y, 0.5) };
  const k = prog(t, AT.cursorIn + 0.1, AT.click - 0.08, easeInOut);
  const u = 1 - k;
  const x = u * u * from.x + 2 * u * k * via.x + k * k * to.x;
  const y = u * u * from.y + 2 * u * k * via.y + k * k * to.y;
  const press = track(t, [[AT.click, 1], [AT.click + 0.07, 0.84], [AT.click + 0.2, 1]]);
  els.cursor.style.transform = `translate(${x - 2.5}px, ${y - 1.5}px) scale(${press})`;
  els.cursor.style.opacity = prog(t, AT.cursorIn, AT.cursorIn + 0.2) * (1 - prog(t, AT.fold + 0.05, AT.fold + 0.25));
  const ring = prog(t, AT.click + 0.03, AT.click + 0.55, easeOut);
  els.ripple.style.transform = `translate(${to.x - 20}px, ${to.y - 20}px) scale(${lerp(0.3, 1.6, ring)})`;
  els.ripple.style.opacity = t >= AT.click + 0.03 ? 0.9 * (1 - ring) : 0;
}

function drawCaptions(t) {
  for (const [id, from, to] of CAPTIONS) {
    const into = prog(t, from, from + 0.4, easeOut);
    const away = prog(t, to - 0.3, to, easeIn);
    els[id].style.opacity = into * (1 - away);
    els[id].style.transform = `translateY(${672 + (1 - into) * 14 - away * 8}px)`;
  }
  // Shade under the caption only while the window reaches the bottom.
  els.scrim.style.opacity = track(t, [[AT.toUsage, 0], [AT.toUsage + 0.7, 1], [AT.toFold, 1], [AT.toFold + 0.7, 0]], linear);
}

function drawTitle(t) {
  const word = 'honeybee';
  const out = prog(t, AT.titleOut, AT.titleOut + 0.35, easeIn);
  let typed = word.length;
  let opacity = 1 - out;
  let caret = false;
  if (t >= AT.type) {
    // Typed back in at the end, with a caret that blinks a while.
    typed = Math.min(word.length, Math.ceil((t - AT.type) / 0.065));
    opacity = 1;
    const since = t - AT.type;
    caret = since < 1.9 && (typed < word.length || Math.floor(since / 0.4) % 2 === 0);
  } else if (t >= AT.titleOut + 0.35) {
    opacity = 0;
  }
  $('wordmark-text').textContent = word.slice(0, typed);
  els.wordmark.style.transform = `translate(${L.wordmark.x + out * 16 * (t < AT.type ? 1 : 0)}px, ${L.wordmark.y}px)`;
  els.wordmark.style.opacity = opacity;
  els.caret.style.left = `${typed * L.char + 5}px`;
  els.caret.style.opacity = caret ? 1 : 0;

  const tagline = t < AT.type
    ? 1 - prog(t, AT.titleOut, AT.titleOut + 0.3, easeIn)
    : prog(t, AT.taglineIn, AT.taglineIn + 0.5, easeOut);
  els.tagline.style.opacity = tagline;
  els.tagline.style.transform = `translateY(${404 + (1 - tagline) * 10}px)`;

  const into = prog(t, AT.endIn, AT.endIn + 0.5, easeOut);
  const away = prog(t, AT.endOut, AT.endOut + 0.35, easeIn);
  els.free.style.opacity = into * (1 - away);
  els.free.style.transform = `translateY(${404 + (1 - into) * 12}px)`;
  const link = prog(t, AT.endIn + 0.15, AT.endIn + 0.65, easeOut);
  els.link.style.opacity = link * (1 - away);
  els.link.style.transform = `translateY(${448 + (1 - link) * 12}px)`;
  els.fine.style.opacity = prog(t, AT.endIn + 0.4, AT.endIn + 0.9) * (1 - away);
  els.fine.style.transform = 'translateY(668px)';
}

function seek(t) {
  stage.t = t;
  drawWidget(t);
  drawWindow(t);
  drawRing(t);
  drawHive(t);
  drawBee(t);
  drawToast(t);
  drawCursor(t);
  drawCaptions(t);
  drawTitle(t);
  // Resolve once the frame with all of that has been painted.
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function until(test, ms = 10000) {
  const end = performance.now() + ms;
  while (!test()) {
    if (performance.now() > end) throw new Error('the honeybee window did not draw');
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

stage.ready = (async () => {
  for (const id of ['window', 'glow', 'ring', 'hive', 'bee', 'toast', 'cursor', 'ripple', 'scrim', 'wordmark', 'caret', 'tagline']) els[id] = $(id);
  Object.assign(els, {
    shadow: $('window-shadow'),
    ringPath: $('ring').querySelector('path'),
    hiveArt: $('hive').querySelector('svg'),
    stripes: $('hive-stripes'),
    count: $('hive-count'),
    hexGlow: $('hex-glow'),
    beeArt: $('bee-art'),
    wings: $('bee-wings'),
    free: $('end-free'),
    link: $('end-link'),
    fine: $('end-fine')
  });
  for (const [id] of CAPTIONS) els[id] = $(id);

  stage.version = (await (await fetch('/package.json')).json()).version;
  const iframe = $('widget');
  const loaded = new Promise((resolve) => iframe.addEventListener('load', resolve, { once: true }));
  iframe.src = '/src/renderer/index.html';
  await loaded;
  const doc = iframe.contentDocument;
  await Promise.all([document, doc].flatMap((d) => ['400', '500', '600'].map((weight) => d.fonts.load(`${weight} 16px "Plex Mono"`))));
  await until(() => doc.getElementById('app').hasAttribute('data-ready'));
  Object.assign(stage.widget, {
    agents: doc.querySelector('.agents-panel'),
    usage: doc.querySelector('.usage-panel'),
    close: doc.querySelector('.control[data-action="close"]')
  });
  await $('toast').querySelector('img').decode();
  layout();
  await seek(0);
  return DURATION;
})();
