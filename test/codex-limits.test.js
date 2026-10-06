'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run, tempDir, clock } = require('./harness');
const { CodexLimits, findCodex, nativeInPackage, snapshotFromResponse, askCodex } = require('../src/main/codex-limits');

// The answer Codex 0.160.1 gave on a Plus account.
const ANSWER = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: 'codex', primary: { usedPercent: 16, windowDurationMins: 300, resetsAt: 1791304146 },
    secondary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: 1791583725 }, planType: 'plus', rateLimitReachedType: null
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex', primary: { usedPercent: 16, windowDurationMins: 300, resetsAt: 1791304146 },
      secondary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: 1791583725 }, planType: 'plus', rateLimitReachedType: null
    }
  }
};

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

test('an answer becomes the same reading the session logs give', () => {
  const snap = snapshotFromResponse(ANSWER, 5000);
  assert.deepStrictEqual(snap, {
    limitId: 'codex',
    planType: 'plus',
    primary: { usedPercent: 16, windowMinutes: 300, resetsAt: 1791304146000 },
    secondary: { usedPercent: 9, windowMinutes: 10080, resetsAt: 1791583725000 },
    reached: null,
    observedAt: 5000
  });
});

test('the codex bucket is preferred, and the single view is used when it is missing', () => {
  const other = { ...ANSWER, rateLimitsByLimitId: { codex: { ...ANSWER.rateLimits, primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1 } } } };
  assert.strictEqual(snapshotFromResponse(other, 1).primary.usedPercent, 40);
  assert.strictEqual(snapshotFromResponse({ ...ANSWER, rateLimitsByLimitId: null }, 1).primary.usedPercent, 16);
});

test('no limits (an API key account) is no reading', () => {
  assert.strictEqual(snapshotFromResponse({ rateLimits: { primary: null, secondary: null } }, 1), null);
  assert.strictEqual(snapshotFromResponse(null, 1), null);
});

test('the native program is found inside an npm install, nested or hoisted', () => {
  const root = tempDir();
  const pkg = path.join(root, 'node_modules', '@openai', 'codex');
  const nested = path.join(pkg, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  touch(nested);
  assert.strictEqual(nativeInPackage(pkg, 'win32', 'x64'), nested);

  const root2 = tempDir();
  const pkg2 = path.join(root2, 'node_modules', '@openai', 'codex');
  const hoisted = path.join(root2, 'node_modules', '@openai', 'codex-darwin-arm64', 'vendor', 'aarch64-apple-darwin', 'bin', 'codex');
  touch(hoisted);
  fs.mkdirSync(pkg2, { recursive: true });
  assert.strictEqual(nativeInPackage(pkg2, 'darwin', 'arm64'), hoisted);
  assert.strictEqual(nativeInPackage(pkg2, 'sunos', 'x64'), null);
});

test('on Windows, an npm codex.cmd on the PATH leads to codex.exe, never the .cmd', () => {
  const home = tempDir();
  const npmDir = path.join(home, 'npm');
  touch(path.join(npmDir, 'codex.cmd'));
  const exe = path.join(npmDir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  touch(exe);
  const env = { PATH: npmDir, HONEYBEE_HOME: home };
  assert.strictEqual(findCodex({ env, platform: 'win32', arch: 'x64' }), exe);
});

test('a standalone codex.exe on the PATH is used as it is', () => {
  const home = tempDir();
  const exe = path.join(home, 'bin', 'codex.exe');
  touch(exe);
  assert.strictEqual(findCodex({ env: { PATH: path.dirname(exe), HONEYBEE_HOME: home }, platform: 'win32', arch: 'x64' }), exe);
});

test('the IDE extension\'s own copy is the last resort', () => {
  const home = tempDir();
  const exe = path.join(home, '.vscode', 'extensions', 'openai.chatgpt-26.5.0-win32-x64', 'bin', 'windows-x86_64', 'codex.exe');
  touch(exe);
  assert.strictEqual(findCodex({ env: { PATH: '', HONEYBEE_HOME: home }, platform: 'win32', arch: 'x64' }), exe);
  assert.strictEqual(findCodex({ env: { PATH: '', HONEYBEE_HOME: tempDir() }, platform: 'win32', arch: 'x64' }), null);
});

// A stand-in for `codex app-server` that speaks just enough of its protocol.
function fakeServer(dir, { answer, silent = false, error = null }) {
  const file = path.join(dir, 'fake-app-server.js');
  fs.writeFileSync(file, `
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin });
    const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      if (${silent}) return;
      if (msg.method === 'initialize') {
        out({ method: 'remoteControl/status/changed', params: {} });
        out({ id: msg.id, result: { userAgent: 'fake' } });
      } else if (msg.method === 'account/rateLimits/read') {
        out(${JSON.stringify(error)} ? { id: msg.id, error: ${JSON.stringify(error)} } : { id: msg.id, result: ${JSON.stringify(answer)} });
      }
    });
    rl.on('close', () => process.exit(0));
  `);
  return file;
}

test('the app server is asked over its own protocol and stopped afterwards', async () => {
  const file = fakeServer(tempDir(), { answer: ANSWER });
  const result = await askCodex(process.execPath, { args: [file], env: process.env });
  assert.deepStrictEqual(result, ANSWER);
});

test('an error answer and a silent server both fail with a reason', async () => {
  const errFile = fakeServer(tempDir(), { error: { message: 'not signed in' } });
  await assert.rejects(askCodex(process.execPath, { args: [errFile] }), /not signed in/);
  const silentFile = fakeServer(tempDir(), { silent: true });
  await assert.rejects(askCodex(process.execPath, { args: [silentFile], timeoutMs: 500 }), /did not answer/);
  await assert.rejects(askCodex(path.join(tempDir(), 'no-such-codex.exe'), {}), /codex/);
});

test('reads are not doubled up, opening the window asks at most once a minute, and failures are logged once', async () => {
  const now = clock();
  const seen = [];
  const logs = [];
  let asks = 0;
  let fail = false;
  const limits = new CodexLimits({
    now,
    log: (m) => logs.push(m),
    onUsage: (s) => seen.push(s),
    find: () => 'codex',
    ask: async () => { asks += 1; if (fail) throw new Error('codex did not answer in time'); return ANSWER; }
  });
  const a = limits.refresh();
  assert.strictEqual(limits.refresh(), a);
  await a;
  assert.strictEqual(asks, 1);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].observedAt, now());

  assert.strictEqual(limits.soon(), null);
  now.advance(61 * 1000);
  await limits.soon();
  assert.strictEqual(asks, 2);

  fail = true;
  await limits.refresh();
  await limits.refresh();
  assert.deepStrictEqual(logs, ['codex limits: reading', 'codex limits: codex did not answer in time']);
  assert.strictEqual(seen.length, 2);
});

test('no Codex on the computer: nothing is started and nothing is reported', async () => {
  let asked = false;
  const limits = new CodexLimits({ onUsage: () => { throw new Error('no'); }, find: () => null, ask: async () => { asked = true; } });
  assert.strictEqual(limits.refresh(), null);
  assert.strictEqual(asked, false);
});

run('codex-limits');
