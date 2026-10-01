'use strict';

const assert = require('assert');
const { test, run, clock } = require('./harness');
const { Usage, parseStatusLine, statusLineText, windowLabel } = require('../src/main/usage');

const statusLine = (five, week, extra = {}) => ({
  session_id: 's1',
  session_name: 'Ship honeybee',
  model: { display_name: 'Opus 5.5' },
  context_window: { used_percentage: 41.6 },
  rate_limits: {
    ...(five ? { five_hour: { used_percentage: five[0], resets_at: five[1] } } : {}),
    ...(week ? { seven_day: { used_percentage: week[0], resets_at: week[1] } } : {})
  },
  ...extra
});

test('the status line payload gives usage and session context', () => {
  const now = Date.UTC(2026, 9, 1);
  const { usage, context } = parseStatusLine(statusLine([23.5, now / 1000 + 3600], [41.2, now / 1000 + 86400]), now);
  assert.strictEqual(usage.fiveHour.usedPercent, 23.5);
  assert.strictEqual(usage.fiveHour.resetsAt, now + 3600 * 1000);
  assert.strictEqual(usage.sevenDay.usedPercent, 41.2);
  assert.deepStrictEqual(context, { sessionId: 's1', contextPercent: 41.6, model: 'Opus 5.5', name: 'Ship honeybee' });
});

test('no rate_limits (API key users, or before the first reply) is no reading, not zero', () => {
  const { usage } = parseStatusLine({ session_id: 's', context_window: {} });
  assert.strictEqual(usage, null);
  assert.strictEqual(parseStatusLine(null).usage, null);
});

test('a window missing from a later reading keeps its last value', () => {
  const now = clock();
  const u = new Usage({ now });
  u.setClaude(parseStatusLine(statusLine([20, now() / 1000 + 3600], [40, now() / 1000 + 86400]), now()).usage);
  u.setClaude(parseStatusLine(statusLine(null, [42, now() / 1000 + 86400]), now()).usage);
  const v = u.view().claude;
  assert.deepStrictEqual(v.windows.map((w) => [w.label, w.usedPercent]), [['5-hour', 20], ['weekly', 42]]);
});

test('a window past its reset time shows as reset, not with its stale number', () => {
  const now = clock();
  const u = new Usage({ now });
  u.setClaude(parseStatusLine(statusLine([97, now() / 1000 + 60], [50, now() / 1000 + 86400]), now()).usage);
  assert.strictEqual(u.view().claude.windows[0].level, 'critical');
  now.advance(61 * 1000);
  const w = u.view().claude.windows[0];
  assert.strictEqual(w.reset, true);
  assert.strictEqual(w.usedPercent, 0);
  assert.strictEqual(w.level, 'ok');
});

test('levels: below 80 ok, to 94 warn, 95 and above critical', () => {
  const now = clock();
  const u = new Usage({ now });
  const at = now() / 1000 + 3600;
  for (const [pct, level] of [[79, 'ok'], [80, 'warn'], [94, 'warn'], [95, 'critical']]) {
    u.setClaude(parseStatusLine(statusLine([pct, at], null), now()).usage);
    assert.strictEqual(u.view().claude.windows[0].level, level, `${pct}%`);
  }
});

test('codex readings: labels from the window length; an older one is ignored', () => {
  const now = clock();
  const u = new Usage({ now });
  u.setCodex({ observedAt: now(), planType: 'plus', primary: { usedPercent: 7, windowMinutes: 300, resetsAt: now() + 1000 }, secondary: { usedPercent: 20, windowMinutes: 10080, resetsAt: now() + 2000 } });
  u.setCodex({ observedAt: now() - 1, primary: { usedPercent: 99, windowMinutes: 300 } });
  const v = u.view().codex;
  assert.strictEqual(v.plan, 'plus');
  assert.deepStrictEqual(v.windows.map((w) => [w.label, w.usedPercent, w.leftPercent]), [['5-hour', 7, 93], ['weekly', 20, 80]]);
  assert.strictEqual(u.peak().usedPercent, 20);
  assert.strictEqual(windowLabel(1440), '1-day');
  assert.strictEqual(windowLabel(120), '2-hour');
});

test('the line Claude Code shows is short and only says what it knows', () => {
  const p = statusLine([23.4, 1], [41.6, 2]);
  assert.strictEqual(statusLineText(p, 0), 'Opus 5.5 · ctx 42% · 5h 23% · wk 42%');
  assert.strictEqual(statusLineText({ model: { display_name: 'Sonnet' } }, null), 'Sonnet');
});

test('serialize and restore round-trip', () => {
  const now = clock();
  const u = new Usage({ now });
  u.setClaude(parseStatusLine(statusLine([5, now() / 1000 + 99], null), now()).usage);
  const copy = new Usage({ now });
  copy.restore(JSON.parse(JSON.stringify(u.serialize())));
  assert.strictEqual(copy.view().claude.windows[0].usedPercent, 5);
});

test('the status bar shows only windows in this payload, and none that already reset', () => {
  const now = Date.UTC(2026, 9, 1);
  const p = statusLine(null, [42, now / 1000 + 60]);
  assert.strictEqual(statusLineText(p, now), 'Opus 5.5 · ctx 42% · wk 42%');
  assert.strictEqual(statusLineText(p, now + 61000), 'Opus 5.5 · ctx 42%');
});

run('usage');
