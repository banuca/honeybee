'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run, tempDir } = require('./harness');
const { readTranscript, readLastTurn, recentTranscripts, projectFolder } = require('../src/main/claude-transcript');

const lines = (...entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

function transcript(dir, slug, id, body) {
  const folder = path.join(dir, slug);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${id}.jsonl`);
  fs.writeFileSync(file, body);
  return file;
}

test('names follow VS Code: rename, then Claude title, then last prompt', () => {
  const dir = tempDir();
  const file = transcript(dir, 'C--work-shop', 's1', lines(
    { type: 'user', message: { content: 'hello' }, cwd: 'C:\\work\\shop', timestamp: '2026-10-01T10:00:00Z' },
    { type: 'last-prompt', lastPrompt: 'make   the  checkout faster' },
    { type: 'ai-title', aiTitle: 'Speed up checkout' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] }, cwd: 'C:\\work\\shop\\api', timestamp: '2026-10-01T10:01:00Z' }
  ));
  let d = readTranscript(file);
  assert.strictEqual(d.title, 'Speed up checkout');
  assert.strictEqual(d.project, 'shop', 'project is the folder the tab opened in, not the subfolder');
  assert.strictEqual(d.lastTurn.kind, 'final');
  fs.appendFileSync(file, lines({ type: 'custom-title', customTitle: 'Checkout perf' }));
  d = readTranscript(file);
  assert.strictEqual(d.title, 'Checkout perf');
});

test('the last turn says whether Claude is waiting on a tool, on you, or finished', () => {
  const dir = tempDir();
  const file = transcript(dir, '-home-me-p', 's2', lines(
    { type: 'user', message: { content: 'go' }, cwd: '/home/me/p' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash' }] } }
  ));
  assert.strictEqual(readLastTurn(file).kind, 'tool');
  fs.appendFileSync(file, lines({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } }));
  assert.strictEqual(readLastTurn(file).kind, 'tool_result');
  fs.appendFileSync(file, lines({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }));
  assert.strictEqual(readLastTurn(file).kind, 'interrupted');
  fs.appendFileSync(file, lines({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sub' }] } }));
  assert.strictEqual(readLastTurn(file).kind, 'interrupted', 'subagent turns are not the main conversation');
});

test('only the head and tail of a large transcript are read', () => {
  const dir = tempDir();
  const filler = lines({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(4000) }] } });
  const file = transcript(dir, '-r-big', 'big', lines({ type: 'ai-title', aiTitle: 'Early title' }) + filler.repeat(300)
    + lines({ type: 'user', message: { content: 'last question' }, cwd: '/r/big' }));
  const d = readTranscript(file);
  assert.strictEqual(d.title, 'Early title');
  assert.strictEqual(d.lastTurn.kind, 'prompt');
});

test('project folder walks up from the working directory to the transcript slug', () => {
  assert.strictEqual(projectFolder('/x/.claude/projects/-home-me-site/a.jsonl', '/home/me/site/src/deep'), 'site');
  assert.strictEqual(projectFolder('/x/.claude/projects/-other/a.jsonl', '/home/me/site'), null);
});

test('recent transcripts are found newest first, and old ones skipped', () => {
  const dir = tempDir();
  const a = transcript(dir, 'p1', 'aaa', lines({ type: 'user', message: { content: 'a' } }));
  const b = transcript(dir, 'p2', 'bbb', lines({ type: 'user', message: { content: 'b' } }));
  const old = Date.now() - 5 * 3600 * 1000;
  fs.utimesSync(a, old / 1000, old / 1000);
  const found = recentTranscripts(dir, Date.now() - 3600 * 1000);
  assert.deepStrictEqual(found.map((f) => f.sessionId), ['bbb']);
  assert.strictEqual(found[0].file, b);
  assert.deepStrictEqual(recentTranscripts(path.join(dir, 'missing'), 0), []);
});

test('a missing or unreadable transcript is not an error', () => {
  assert.strictEqual(readTranscript('/definitely/not/here.jsonl'), null);
  assert.strictEqual(readLastTurn('/definitely/not/here.jsonl'), null);
});

test('a text line mid-turn is not a finished reply; only end_turn is', () => {
  const dir = tempDir();
  const file = transcript(dir, '-x-y', 'mid', lines(
    { type: 'user', message: { content: 'go' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Let me check the tests.' }], stop_reason: 'tool_use' } }
  ));
  assert.strictEqual(readLastTurn(file).kind, 'tool');
  fs.appendFileSync(file, lines({ type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }], stop_reason: null } }));
  assert.strictEqual(readLastTurn(file).kind, 'tool', 'still streaming');
  fs.appendFileSync(file, lines({ type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }], stop_reason: 'end_turn' } }));
  const turn = readLastTurn(file);
  assert.strictEqual(turn.kind, 'final');
  assert.strictEqual(turn.text, 'All done.');
});

run('claude transcripts');
