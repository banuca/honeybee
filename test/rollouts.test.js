'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run, tempDir } = require('./harness');
const { CodexRollouts, applyLine, parseRateLimits, isRealPrompt } = require('../src/main/codex-rollouts');

const line = (o) => JSON.stringify(o) + '\n';

function dayDir(root, ms) {
  const d = new Date(ms);
  const dir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const meta = (id, cwd, ts) => line({ timestamp: ts, type: 'session_meta', payload: { id, cwd, originator: 'codex_vscode', timestamp: ts } });
const userMsg = (text, ts) => line({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const started = (ts) => line({ timestamp: ts, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', started_at: Date.parse(ts) / 1000 } });
const complete = (ts, msg) => line({ timestamp: ts, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: msg, completed_at: Date.parse(ts) / 1000 } });
const tokens = (ts, primary, secondary) => line({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: {}, rate_limits: {
  limit_id: 'codex', primary: { used_percent: primary, window_minutes: 300, resets_at: Date.parse(ts) / 1000 + 3600 },
  secondary: { used_percent: secondary, window_minutes: 10080, resets_at: Date.parse(ts) / 1000 + 86400 }, plan_type: 'plus' } } });

test('rate limits parse from a token_count event, including the older resets_in_seconds form', () => {
  const snap = parseRateLimits({ primary: { used_percent: 7, window_minutes: 300, resets_at: 1790265934 }, secondary: { used_percent: 20.5, window_minutes: 10080, resets_in_seconds: 60 }, plan_type: 'plus' }, 1000);
  assert.strictEqual(snap.primary.usedPercent, 7);
  assert.strictEqual(snap.primary.resetsAt, 1790265934000);
  assert.strictEqual(snap.secondary.resetsAt, 61000);
  assert.strictEqual(snap.planType, 'plus');
  assert.strictEqual(parseRateLimits(null, 1), null);
  assert.strictEqual(parseRateLimits({ primary: { used_percent: 'x' } }, 1), null);
});

test('context blocks are not prompts; the first real message is the title', () => {
  assert.strictEqual(isRealPrompt('<environment_context> <cwd>D:\\</cwd>'), false);
  assert.strictEqual(isRealPrompt('# AGENTS.md instructions'), false);
  assert.strictEqual(isRealPrompt('rename my files'), true);
  const state = {};
  applyLine(state, userMsg('<environment_context>x</environment_context>', '2026-10-01T10:00:00Z'));
  assert.strictEqual(state.title, undefined);
  applyLine(state, userMsg('rename   my files please', '2026-10-01T10:00:01Z'));
  assert.strictEqual(state.title, 'rename my files please');
  applyLine(state, userMsg('second message', '2026-10-01T10:00:02Z'));
  assert.strictEqual(state.title, 'rename my files please');
});

test('a session is followed from startup through new turns and new rate limits', () => {
  const root = tempDir();
  const now = Date.now();
  const dir = dayDir(root, now);
  const file = path.join(dir, 'rollout-2026-10-01T10-00-00-abc.jsonl');
  const t0 = new Date(now - 60000).toISOString();
  fs.writeFileSync(file, meta('abc', 'C:\\proj\\site', t0) + userMsg('<environment_context/>', t0) + userMsg('build the page', t0)
    + started(t0) + tokens(t0, 10, 30) + complete(t0, 'Built it.'));

  const sessions = [];
  const usage = [];
  const watcher = new CodexRollouts({ sessionsDir: root, onSession: (s) => sessions.push(s), onUsage: (u) => usage.push(u) });
  watcher.scanInitial();
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].id, 'abc');
  assert.strictEqual(sessions[0].project, 'site');
  assert.strictEqual(sessions[0].title, 'build the page');
  assert.strictEqual(sessions[0].last.kind, 'complete');
  assert.strictEqual(sessions[0].initial, true);
  assert.strictEqual(usage[usage.length - 1].primary.usedPercent, 10);

  const t1 = new Date(now).toISOString();
  // A line written in two pieces must be read once, whole.
  const next = started(t1) + tokens(t1, 12, 31);
  fs.appendFileSync(file, next.slice(0, 40));
  watcher.pollKnown();
  fs.appendFileSync(file, next.slice(40));
  watcher.pollKnown();
  const last = sessions[sessions.length - 1];
  assert.strictEqual(last.last.kind, 'started');
  assert.strictEqual(last.initial, false);
  assert.strictEqual(usage[usage.length - 1].primary.usedPercent, 12);
  assert.strictEqual(usage[usage.length - 1].secondary.usedPercent, 31);
});

test('the newest rate limits are found even when no session is active', () => {
  const root = tempDir();
  const now = Date.now();
  const dir = dayDir(root, now - 86400000);
  const file = path.join(dir, 'rollout-old.jsonl');
  const ts = new Date(now - 86400000).toISOString();
  fs.writeFileSync(file, meta('old', '/w', ts) + tokens(ts, 55, 70));
  const old = (now - 20 * 3600 * 1000) / 1000;
  fs.utimesSync(file, old, old);
  const sessions = [];
  const usage = [];
  new CodexRollouts({ sessionsDir: root, onSession: (s) => sessions.push(s), onUsage: (u) => usage.push(u) }).scanInitial();
  assert.strictEqual(sessions.length, 0, 'a session idle for 20 hours is not listed');
  assert.strictEqual(usage.length, 1);
  assert.strictEqual(usage[0].secondary.usedPercent, 70);
});

test('an older reading never replaces a newer one', () => {
  const usage = [];
  const watcher = new CodexRollouts({ sessionsDir: tempDir(), onSession: () => {}, onUsage: (u) => usage.push(u) });
  watcher.offerUsage({ observedAt: 2000, primary: { usedPercent: 50 } });
  watcher.offerUsage({ observedAt: 1000, primary: { usedPercent: 10 } });
  assert.strictEqual(usage.length, 1);
  assert.strictEqual(watcher.latestUsage.primary.usedPercent, 50);
});

test('no sessions folder is simply nothing to show', () => {
  const watcher = new CodexRollouts({ sessionsDir: path.join(tempDir(), 'nope'), onSession: () => { throw new Error('no'); }, onUsage: () => { throw new Error('no'); } });
  watcher.scanInitial();
  watcher.pollKnown();
});

test('a character split across two reads arrives whole', () => {
  const root = tempDir();
  const now = Date.now();
  const dir = dayDir(root, now);
  const file = path.join(dir, 'rollout-utf8.jsonl');
  const t0 = new Date(now).toISOString();
  fs.writeFileSync(file, meta('u8', '/w/u8', t0));
  const sessions = [];
  const watcher = new CodexRollouts({ sessionsDir: root, onSession: (s) => sessions.push(s), onUsage: () => {} });
  watcher.scanInitial();
  const bytes = Buffer.from(userMsg('café ☕ naïve', t0), 'utf8');
  const cut = bytes.indexOf(Buffer.from('☕')) + 1; // inside the three-byte character
  fs.appendFileSync(file, bytes.subarray(0, cut));
  watcher.pollKnown();
  fs.appendFileSync(file, bytes.subarray(cut));
  watcher.pollKnown();
  assert.strictEqual(sessions[sessions.length - 1].title, 'café ☕ naïve');
});

test('a resumed session in an older day folder is picked up, and quiet files are let go', () => {
  const root = tempDir();
  const now = Date.now();
  const oldDir = dayDir(root, now - 4 * 86400000);
  const file = path.join(oldDir, 'rollout-resumed.jsonl');
  const ts = new Date(now - 4 * 86400000).toISOString();
  fs.writeFileSync(file, meta('resumed', '/w/r', ts));
  const old = (now - 4 * 86400000) / 1000;
  fs.utimesSync(file, old, old);
  const sessions = [];
  const watcher = new CodexRollouts({ sessionsDir: root, onSession: (s) => sessions.push(s), onUsage: () => {} });
  watcher.scanInitial();
  assert.strictEqual(sessions.length, 0, 'idle for days: not listed');
  fs.appendFileSync(file, started(new Date(now).toISOString()));
  watcher.discover(false);
  assert.strictEqual(sessions[sessions.length - 1].id, 'resumed');
  assert.strictEqual(sessions[sessions.length - 1].last.kind, 'started');
  assert.ok(watcher.files.has(file));
  fs.utimesSync(file, old, old);
  watcher.pollKnown();
  assert.ok(!watcher.files.has(file), 'a file quiet for longer than the active window is no longer polled');
});

run('codex rollouts');
