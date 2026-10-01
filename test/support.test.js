'use strict';

// The small kept modules: the JSON store, window placement, update checks.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run, tempDir } = require('./harness');
const { JsonStore } = require('../src/main/store');
const { fitBoundsToDisplays, isReachable } = require('../src/main/window-bounds');
const { isNewerVersion, parseReleaseResponse } = require('../src/main/version-compare');

test('store: defaults, save, reload', () => {
  const file = path.join(tempDir(), 'settings.json');
  const a = new JsonStore(file, { theme: 'system', n: 1 });
  assert.strictEqual(a.get('theme'), 'system');
  a.set('n', 2);
  assert.ok(a.saveNow());
  const b = new JsonStore(file, { theme: 'system', n: 1, added: true });
  assert.strictEqual(b.get('n'), 2);
  assert.strictEqual(b.get('added'), true, 'a default added in a newer version appears');
});

test('store: an unreadable file is set aside, never deleted', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{oops');
  const s = new JsonStore(file, { ok: true });
  assert.strictEqual(s.get('ok'), true);
  assert.ok(s.problem);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('settings.json.unreadable-')));
});

test('window: saved bounds on a monitor that is gone come back on screen', () => {
  const displays = [{ id: 1, primary: true, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  const fitted = fitBoundsToDisplays({ x: 2500, y: 100, width: 380, height: 520 }, displays, { minWidth: 300, minHeight: 200 });
  assert.ok(isReachable(fitted.bounds, displays));
  assert.strictEqual(fitted.reason, 'moved-onto-an-attached-display');
});

test('updates: only a newer stable release counts', () => {
  assert.strictEqual(isNewerVersion('4.0.1', '4.0.0'), true);
  assert.strictEqual(isNewerVersion('4.0.0', '4.0.0'), false);
  assert.strictEqual(isNewerVersion('4.1.0-beta.1', '4.0.0'), false);
  assert.strictEqual(parseReleaseResponse('{"message":"API rate limit exceeded"}', '4.0.0').hasUpdate, false);
  assert.strictEqual(parseReleaseResponse('{"tag_name":"v4.2.0"}', '4.0.0').version, '4.2.0');
});

run('support');
