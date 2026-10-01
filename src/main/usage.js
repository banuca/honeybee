'use strict';

// How much of each plan's limits is left.
//
// Claude: Claude Code passes its own rate-limit reading to the status line
// command on every update (rate_limits.five_hour / seven_day). honeybee's
// status line forwards that here. Nothing is fetched and no sign-in is used.
//
// Codex: the rate limits Codex records in its session logs (see
// codex-rollouts.js).
//
// A reading is a snapshot from a moment in the past, so every view carries the
// time it was taken, and a window whose reset time has passed is shown as
// reset rather than with its old, no-longer-true number.

const WARN = 80;
const CRITICAL = 95;

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function epochMs(seconds) {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

function claudeWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const usedPercent = clampPercent(raw.used_percentage);
  if (usedPercent === null) return null;
  return { usedPercent, resetsAt: epochMs(raw.resets_at) };
}

/**
 * Split a status line payload into the parts honeybee uses.
 * @returns {{ usage: object|null, context: object|null }}
 */
function parseStatusLine(p, now = Date.now()) {
  if (!p || typeof p !== 'object') return { usage: null, context: null };
  const rl = p.rate_limits && typeof p.rate_limits === 'object' ? p.rate_limits : null;
  let usage = null;
  if (rl) {
    const fiveHour = claudeWindow(rl.five_hour);
    const sevenDay = claudeWindow(rl.seven_day);
    const spendLimit = rl.spend_limit && typeof rl.spend_limit === 'object' && Number.isFinite(Number(rl.spend_limit.used_percentage))
      ? { usedPercent: Math.max(0, Number(rl.spend_limit.used_percentage)), resetsAt: epochMs(rl.spend_limit.resets_at) }
      : null;
    if (fiveHour || sevenDay || spendLimit) usage = { fiveHour, sevenDay, spendLimit, observedAt: now };
  }
  const cw = p.context_window && typeof p.context_window === 'object' ? p.context_window : {};
  const context = typeof p.session_id === 'string' ? {
    sessionId: p.session_id,
    contextPercent: clampPercent(cw.used_percentage),
    model: p.model && typeof p.model.display_name === 'string' ? p.model.display_name : null,
    name: typeof p.session_name === 'string' ? p.session_name : null
  } : null;
  return { usage, context };
}

function levelFor(used) {
  if (used === null) return 'unknown';
  if (used >= CRITICAL) return 'critical';
  if (used >= WARN) return 'warn';
  return 'ok';
}

function windowLabel(minutes) {
  if (minutes === 300) return '5-hour';
  if (minutes === 10080) return 'weekly';
  if (!Number.isFinite(minutes) || minutes <= 0) return 'limit';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-min`;
}

function windowView(label, w, observedAt, now) {
  if (!w) return null;
  const reset = Boolean(w.resetsAt && now >= w.resetsAt);
  const used = reset ? 0 : w.usedPercent;
  return {
    label,
    usedPercent: Math.round(used),
    leftPercent: Math.max(0, Math.round(100 - used)),
    resetsAt: w.resetsAt || null,
    reset,
    level: reset ? 'ok' : levelFor(used),
    observedAt
  };
}

class Usage {
  constructor({ now = Date.now, onChange = () => {} } = {}) {
    this.now = now;
    this.onChange = onChange;
    this.claude = null;
    this.codex = null;
  }

  /**
   * Merge a Claude reading. Claude Code may leave a window out (it drops one
   * once it resets), so a window missing from this reading keeps its last value.
   */
  setClaude(reading) {
    if (!reading) return;
    const previous = this.claude || {};
    this.claude = {
      fiveHour: reading.fiveHour || previous.fiveHour || null,
      sevenDay: reading.sevenDay || previous.sevenDay || null,
      spendLimit: reading.spendLimit || previous.spendLimit || null,
      observedAt: reading.observedAt
    };
    this.onChange();
  }

  setCodex(snapshot) {
    if (!snapshot) return;
    if (this.codex && (this.codex.observedAt || 0) > (snapshot.observedAt || 0)) return;
    this.codex = snapshot;
    this.onChange();
  }

  view() {
    const now = this.now();
    const c = this.claude;
    const x = this.codex;
    return {
      claude: c ? {
        observedAt: c.observedAt,
        windows: [
          windowView('5-hour', c.fiveHour, c.observedAt, now),
          windowView('weekly', c.sevenDay, c.observedAt, now),
          c.spendLimit ? { ...windowView('spend', { ...c.spendLimit, usedPercent: Math.min(100, c.spendLimit.usedPercent) }, c.observedAt, now), over: c.spendLimit.usedPercent > 100 } : null
        ].filter(Boolean)
      } : null,
      codex: x ? {
        observedAt: x.observedAt,
        plan: x.planType,
        reached: x.reached,
        windows: [
          x.primary ? windowView(windowLabel(x.primary.windowMinutes), x.primary, x.observedAt, now) : null,
          x.secondary ? windowView(windowLabel(x.secondary.windowMinutes), x.secondary, x.observedAt, now) : null
        ].filter(Boolean)
      } : null
    };
  }

  /** The most-used window across both agents, for the tray and the bubble. */
  peak() {
    const v = this.view();
    let peak = null;
    for (const agent of ['claude', 'codex']) {
      for (const w of (v[agent] ? v[agent].windows : [])) {
        if (!peak || w.usedPercent > peak.usedPercent) peak = { agent, ...w };
      }
    }
    return peak;
  }

  serialize() {
    return { claude: this.claude, codex: this.codex };
  }

  restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    if (saved.claude && typeof saved.claude === 'object') this.claude = saved.claude;
    if (saved.codex && typeof saved.codex === 'object') this.codex = saved.codex;
  }
}

/**
 * The line Claude Code shows in its status bar. Built from this payload alone:
 * when Claude Code leaves a window out (it drops one once it resets), the
 * status bar must not keep showing that window's old number.
 */
function statusLineText(p, now = Date.now()) {
  const parts = [];
  if (p && p.model && typeof p.model.display_name === 'string') parts.push(p.model.display_name);
  const ctx = p && p.context_window ? clampPercent(p.context_window.used_percentage) : null;
  if (ctx !== null) parts.push(`ctx ${Math.round(ctx)}%`);
  const { usage } = parseStatusLine(p, now);
  const live = (w) => w && !(w.resetsAt && now >= w.resetsAt);
  if (usage && live(usage.fiveHour)) parts.push(`5h ${Math.round(usage.fiveHour.usedPercent)}%`);
  if (usage && live(usage.sevenDay)) parts.push(`wk ${Math.round(usage.sevenDay.usedPercent)}%`);
  return parts.join(' · ');
}

module.exports = { Usage, parseStatusLine, statusLineText, windowLabel, levelFor, WARN, CRITICAL };
