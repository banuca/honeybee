/**
 * window-bounds.js
 *
 * Keeping the restored window somewhere the user can actually see it.
 *
 * The saved {x, y, width, height} used to be handed straight to
 * BrowserWindow. That is fine until the display arrangement changes: unplug
 * the laptop from a second monitor, change scaling, or move a monitor from the
 * right side to the left, and the coordinates that were valid last session now
 * point at nothing. The window is then created off-screen — and because the
 * tray icon is off by default, there is no way to get it back. The widget is
 * running, invisible, and the only recovery is deleting the config.
 *
 * So the saved bounds are treated as a preference, not an instruction: they
 * are fitted to whatever displays exist right now, and the same fitting runs
 * again whenever the display arrangement changes while the app is open.
 *
 * Pure geometry, no Electron: the caller passes the display list it got from
 * `screen`, which makes the whole matrix (monitor removed, resolution shrunk,
 * negative coordinates on a left-hand monitor, DPI change) unit-testable.
 */
'use strict';

// How much of the window has to be on-screen for it to count as reachable.
// A window is grabbable by its title bar, so the top strip is what matters.
const MIN_VISIBLE_WIDTH = 120;
const MIN_VISIBLE_HEIGHT = 40;

function intersectionArea(a, b) {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return { width: x, height: y, area: x * y };
}

/**
 * Is enough of this window on an attached display to be usable?
 *
 * @param {Object} bounds  {x, y, width, height}
 * @param {Array}  displays [{ workArea: {x,y,width,height}, id?, primary? }]
 */
function isReachable(bounds, displays) {
  if (!bounds || !Array.isArray(displays) || displays.length === 0) return false;
  return displays.some((display) => {
    const overlap = intersectionArea(bounds, display.workArea || display.bounds);
    return overlap.width >= Math.min(MIN_VISIBLE_WIDTH, bounds.width)
      && overlap.height >= Math.min(MIN_VISIBLE_HEIGHT, bounds.height);
  });
}

// The display this window belongs to: the one it overlaps most, or the
// primary one when it overlaps nothing at all.
function displayFor(bounds, displays) {
  let best = null;
  let bestArea = 0;
  for (const display of displays) {
    const area = intersectionArea(bounds, display.workArea || display.bounds).area;
    if (area > bestArea) {
      bestArea = area;
      best = display;
    }
  }
  if (best) return best;
  return displays.find((d) => d.primary) || displays[0];
}

/**
 * Fit saved bounds onto the displays that exist now.
 *
 * @param {Object} bounds  the saved {x, y, width, height}
 * @param {Array}  displays [{ workArea, bounds, id?, primary? }]
 * @param {Object} [limits] { minWidth, minHeight }
 * @returns {{bounds: Object, changed: boolean, reason: string, displayId: *}}
 */
function fitBoundsToDisplays(bounds, displays, { minWidth = 1, minHeight = 1 } = {}) {
  if (!bounds || typeof bounds.width !== 'number' || typeof bounds.height !== 'number') {
    return { bounds: null, changed: false, reason: 'no-saved-bounds', displayId: null };
  }
  if (!Array.isArray(displays) || displays.length === 0) {
    // No display information (a headless or very early call): leave the saved
    // values alone rather than inventing a position.
    return { bounds: { ...bounds }, changed: false, reason: 'no-display-information', displayId: null };
  }

  const alreadyFine = isReachable(bounds, displays);
  const display = displayFor(bounds, displays);
  const area = display.workArea || display.bounds;

  // Never larger than the display it is on, never smaller than the app's own
  // minimum. A monitor smaller than the minimum wins: an unusably small window
  // is still better than one that cannot be dragged into view.
  const width = Math.max(Math.min(bounds.width, area.width), Math.min(minWidth, area.width));
  const height = Math.max(Math.min(bounds.height, area.height), Math.min(minHeight, area.height));

  const x = Math.round(Math.min(Math.max(bounds.x, area.x), area.x + area.width - width));
  const y = Math.round(Math.min(Math.max(bounds.y, area.y), area.y + area.height - height));

  const fitted = { x, y, width: Math.round(width), height: Math.round(height) };
  const changed = fitted.x !== bounds.x || fitted.y !== bounds.y
    || fitted.width !== bounds.width || fitted.height !== bounds.height;

  return {
    bounds: fitted,
    changed,
    reason: alreadyFine
      ? (changed ? 'clamped-to-work-area' : 'unchanged')
      : 'moved-onto-an-attached-display',
    displayId: display.id === undefined ? null : display.id
  };
}

module.exports = {
  MIN_VISIBLE_WIDTH,
  MIN_VISIBLE_HEIGHT,
  isReachable,
  displayFor,
  fitBoundsToDisplays
};
