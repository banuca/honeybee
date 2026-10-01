'use strict';

const assert = require('assert');
const http = require('http');
const { test, run } = require('./harness');
const { createServer } = require('../src/main/server');

const TOKEN = 'b'.repeat(48);

function request(port, { method = 'POST', path = '/claude/hook', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'x-honeybee': TOKEN, 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withServer(fn) {
  const seen = { claude: [], codex: [], status: [] };
  const server = createServer({
    token: TOKEN,
    handlers: {
      claudeHook: (p) => seen.claude.push(p),
      codexHook: (p) => seen.codex.push(p),
      claudeStatusLine: (p) => { seen.status.push(p); return `ctx ${p.n}%`; }
    }
  });
  const port = await server.listen(0);
  try {
    await fn(port, seen);
  } finally {
    await server.close();
  }
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test('hooks are answered with an empty 200 and delivered', () => withServer(async (port, seen) => {
  const res = await request(port, { body: JSON.stringify({ session_id: 's', hook_event_name: 'Stop' }) });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.text, '', 'an empty body is "no decision" to Claude Code and no model context for Codex');
  const codex = await request(port, { path: '/codex/hook', body: JSON.stringify({ session_id: 'x' }) });
  assert.strictEqual(codex.text, '');
  await tick();
  assert.strictEqual(seen.claude[0].hook_event_name, 'Stop');
  assert.strictEqual(seen.codex[0].session_id, 'x');
}));

test('the status line route answers with the text to show', () => withServer(async (port, seen) => {
  const res = await request(port, { path: '/claude/statusline', body: JSON.stringify({ n: 42 }) });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.text, 'ctx 42%');
  assert.strictEqual(seen.status.length, 1);
}));

test('no token, a wrong token, a browser origin or a foreign host is refused', () => withServer(async (port, seen) => {
  assert.strictEqual((await request(port, { headers: { 'x-honeybee': 'nope' }, body: '{}' })).status, 401);
  assert.strictEqual((await request(port, { headers: { 'x-honeybee': '' }, body: '{}' })).status, 401);
  assert.strictEqual((await request(port, { headers: { origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.strictEqual((await request(port, { headers: { host: `evil.example:${port}` }, body: '{}' })).status, 403);
  assert.strictEqual((await request(port, { path: '/other', body: '{}' })).status, 404);
  assert.strictEqual((await request(port, { method: 'GET', path: '/claude/hook' })).status, 405);
  await tick();
  assert.strictEqual(seen.claude.length, 0);
}));

test('garbage and oversized bodies are ignored without an error status', () => withServer(async (port, seen) => {
  assert.strictEqual((await request(port, { body: 'not json' })).status, 200);
  const big = JSON.stringify({ session_id: 's', blob: 'x'.repeat(5 * 1024 * 1024) });
  assert.strictEqual((await request(port, { body: big })).status, 200);
  await tick();
  assert.strictEqual(seen.claude.length, 0);
}));

test('a port already in use is reported, not swallowed', async () => {
  const first = createServer({ token: TOKEN, handlers: {} });
  const port = await first.listen(0);
  const second = createServer({ token: TOKEN, handlers: {} });
  await assert.rejects(second.listen(port), /EADDRINUSE/);
  await first.close();
});

test('health answers only with the token', () => withServer(async (port) => {
  const ok = await request(port, { method: 'GET', path: '/health' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(JSON.parse(ok.text).app, 'honeybee');
  assert.strictEqual((await request(port, { method: 'GET', path: '/health', headers: { 'x-honeybee': 'x' } })).status, 401);
}));

run('server');
