'use strict';

// The folded-up honeybee: one hexagon that shows whether anything needs you.
// Click it to open the window, drag it anywhere, right-click for the menu.

const bubble = document.getElementById('bubble');
const count = document.getElementById('count');
let flashTimer = null;

function summary(state) {
  const c = state.counts;
  const lines = [];
  for (const s of state.agents.filter((x) => x.status === 'needs-you').slice(0, 3)) {
    lines.push(`needs you: ${s.title || s.project || 'a session'}${s.reason ? ` (${s.reason})` : ''}`);
  }
  if (c.working) lines.push(`${c.working} working`);
  if (!lines.length) lines.push(c.total ? 'all quiet' : 'no agents yet');
  return `honeybee\n${lines.join('\n')}`;
}

// Motion is stepped, a few repaints a second at most, and only while
// something is happening: the bubble stays on screen all day.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let stepper = null;
function setMotion(kind) {
  clearInterval(stepper);
  stepper = null;
  bubble.dataset.phase = '0';
  if (!kind || reducedMotion.matches) return;
  let phase = 0;
  stepper = setInterval(() => {
    phase = (phase + 1) % 4;
    bubble.dataset.phase = String(phase);
  }, kind === 'working' ? 600 : 800);
}

function render(state) {
  const c = state.counts;
  let next = 'idle';
  if (c['needs-you'] > 0) {
    next = 'needs';
    count.textContent = String(c['needs-you']);
  } else if (c.working > 0) {
    next = 'working';
    count.textContent = String(c.working);
  } else {
    count.textContent = '';
  }
  if (bubble.dataset.state !== next || (next !== 'idle' && !stepper)) {
    bubble.dataset.state = next;
    setMotion(next === 'idle' ? null : next);
  }
  bubble.title = summary(state);
}

window.bubbleApi.onState(render);
window.bubbleApi.getState().then(render);
window.bubbleApi.onFlash((kind) => {
  if (kind !== 'done' && kind !== 'failed') return;
  bubble.dataset.flash = kind;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { delete bubble.dataset.flash; }, 2600);
});

// Dragging is done by the main process from the real cursor position, so it
// stays right across monitors with different scaling.
let pressed = false;
let frame = 0;
bubble.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  pressed = true;
  bubble.setPointerCapture(event.pointerId);
  window.bubbleApi.pointer('down');
});
bubble.addEventListener('pointermove', () => {
  if (!pressed || frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    window.bubbleApi.pointer('move');
  });
});
bubble.addEventListener('pointerup', (event) => {
  if (!pressed) return;
  pressed = false;
  bubble.releasePointerCapture(event.pointerId);
  window.bubbleApi.pointer('up');
});
bubble.addEventListener('pointercancel', () => {
  pressed = false;
  window.bubbleApi.pointer('cancel');
});
bubble.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.bubbleApi.menu();
});
bubble.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    window.bubbleApi.pointer('down');
    window.bubbleApi.pointer('up');
  }
});
