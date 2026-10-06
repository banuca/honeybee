'use strict';

const assert = require('assert');
const { test, run, clock } = require('./harness');
const { Agents, toolLabel } = require('../src/main/agents');

function make() {
  const now = clock();
  const alerts = [];
  let changes = 0;
  const agents = new Agents({ now, onAlert: (a) => alerts.push(a), onChange: () => { changes += 1; } });
  return { agents, alerts, now, changes: () => changes };
}

const claude = (event, extra = {}) => ({ session_id: 'c1', hook_event_name: event, cwd: '/home/me/proj', transcript_path: '/t/c1.jsonl', ...extra });
const codex = (event, extra = {}) => ({ session_id: 'x1', hook_event_name: event, cwd: 'D:\\work\\app', ...extra });

test('claude: prompt, approval, approved tool, finish', () => {
  const { agents, alerts } = make();
  agents.claudeEvent(claude('UserPromptSubmit', { prompt: 'fix the   failing test' }));
  let s = agents.get('claude', 'c1');
  assert.strictEqual(s.status, 'working');
  assert.strictEqual(s.title, 'fix the failing test');
  assert.strictEqual(s.project, 'proj');

  agents.claudeEvent(claude('PermissionRequest', { tool_name: 'Bash', tool_use_id: 'tu1' }));
  s = agents.get('claude', 'c1');
  assert.strictEqual(s.status, 'needs-you');
  assert.strictEqual(s.reason, 'approve a command');
  assert.deepStrictEqual(alerts.map((a) => a.kind), ['needs-you']);

  agents.claudeEvent(claude('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu1' }));
  assert.strictEqual(agents.get('claude', 'c1').status, 'working');

  agents.claudeEvent(claude('Stop', { last_assistant_message: 'All green.\nDetails follow.' }));
  s = agents.get('claude', 'c1');
  assert.strictEqual(s.status, 'done');
  assert.strictEqual(s.lastMessage, 'All green. Details follow.');
  assert.deepStrictEqual(alerts.map((a) => a.kind), ['needs-you', 'done']);
});

test('claude: a parallel tool finishing does not settle another tool\'s approval', () => {
  const { agents } = make();
  agents.claudeEvent(claude('UserPromptSubmit'));
  agents.claudeEvent(claude('PermissionRequest', { tool_name: 'Edit', tool_use_id: 'A' }));
  agents.claudeEvent(claude('PostToolUse', { tool_name: 'Read', tool_use_id: 'B' }));
  assert.strictEqual(agents.get('claude', 'c1').status, 'needs-you');
  agents.claudeEvent(claude('PostToolUseFailure', { tool_name: 'Edit', tool_use_id: 'A' }));
  assert.strictEqual(agents.get('claude', 'c1').status, 'working');
});

test('claude: a question or a plan waits for the user', () => {
  const { agents } = make();
  agents.claudeEvent(claude('UserPromptSubmit'));
  agents.claudeEvent(claude('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'q' }));
  assert.strictEqual(agents.get('claude', 'c1').reason, 'answer a question');
  agents.claudeEvent(claude('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'q' }));
  assert.strictEqual(agents.get('claude', 'c1').status, 'working');
  agents.claudeEvent(claude('PreToolUse', { tool_name: 'ExitPlanMode', tool_use_id: 'p' }));
  assert.strictEqual(agents.get('claude', 'c1').reason, 'review the plan');
});

test('claude: a permission notification alone still means needs-you', () => {
  const { agents } = make();
  agents.claudeEvent(claude('UserPromptSubmit'));
  agents.claudeEvent(claude('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }));
  const s = agents.get('claude', 'c1');
  assert.strictEqual(s.status, 'needs-you');
  assert.strictEqual(s.reason, 'approve a command');
  agents.claudeEvent(claude('PostToolUse', { tool_name: 'Bash', tool_use_id: 'zz' }));
  assert.strictEqual(agents.get('claude', 'c1').status, 'working');
});

test('claude: the same news by two routes alerts once', () => {
  const { agents, alerts } = make();
  agents.claudeEvent(claude('UserPromptSubmit'));
  agents.claudeEvent(claude('PermissionRequest', { tool_name: 'Bash', tool_use_id: 'tu1' }));
  agents.claudeEvent(claude('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }));
  agents.claudeEvent(claude('Stop'));
  agents.claudeEvent(claude('Stop'));
  assert.deepStrictEqual(alerts.map((a) => a.kind), ['needs-you', 'done']);
});

test('claude: subagent events are not sessions; SessionEnd removes the row', () => {
  const { agents } = make();
  agents.claudeEvent(claude('UserPromptSubmit', { agent_id: 'sub-1' }));
  assert.strictEqual(agents.get('claude', 'c1'), null);
  agents.claudeEvent(claude('UserPromptSubmit'));
  agents.claudeEvent(claude('SessionEnd', { reason: 'other' }));
  assert.strictEqual(agents.get('claude', 'c1'), null);
});

test('claude: an API failure is a failed turn with a plain reason', () => {
  const { agents, alerts } = make();
  agents.claudeEvent(claude('UserPromptSubmit'));
  agents.claudeEvent(claude('StopFailure', { error_type: 'rate_limit' }));
  const s = agents.get('claude', 'c1');
  assert.strictEqual(s.status, 'failed');
  assert.strictEqual(s.reason, 'usage limit reached');
  assert.deepStrictEqual(alerts.map((a) => a.kind), ['failed']);
});

test('claude: Esc shows as stopped, quietly', () => {
  const { agents, alerts } = make();
  agents.claudeEvent(claude('UserPromptSubmit'));
  agents.claudeTurn('claude:c1', { kind: 'interrupted', at: 1 });
  assert.strictEqual(agents.get('claude', 'c1').status, 'stopped');
  assert.strictEqual(alerts.length, 0);
});

test('codex: hooks drive the whole turn', () => {
  const { agents, alerts } = make();
  agents.codexEvent(codex('SessionStart', { source: 'startup' }));
  assert.strictEqual(agents.get('codex', 'x1').status, 'idle');
  assert.strictEqual(agents.get('codex', 'x1').project, 'app');
  agents.codexEvent(codex('UserPromptSubmit', { prompt: 'rename the files' }));
  agents.codexEvent(codex('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'mv a b' } }));
  assert.strictEqual(agents.get('codex', 'x1').reason, 'approve a command');
  agents.codexEvent(codex('PostToolUse', { tool_name: 'Bash', tool_use_id: 'call_1' }));
  assert.strictEqual(agents.get('codex', 'x1').status, 'working');
  agents.codexEvent(codex('Stop', { last_assistant_message: 'Renamed 3 files.' }));
  assert.strictEqual(agents.get('codex', 'x1').status, 'done');
  agents.codexEvent(codex('UserPromptSubmit'));
  agents.codexEvent(codex('Interrupt'));
  assert.strictEqual(agents.get('codex', 'x1').status, 'stopped');
  assert.deepStrictEqual(alerts.map((a) => a.kind), ['needs-you', 'done']);
});

test('codex: a log line older than the last hook cannot rewind the session', () => {
  const { agents, alerts, now } = make();
  agents.codexEvent(codex('UserPromptSubmit'));
  const hookAt = now();
  now.advance(500);
  agents.codexLog({ id: 'x1', last: { kind: 'complete', at: hookAt - 5000, lastMessage: 'old turn' } });
  assert.strictEqual(agents.get('codex', 'x1').status, 'working');
  agents.codexLog({ id: 'x1', last: { kind: 'complete', at: now(), lastMessage: 'this turn' } });
  assert.strictEqual(agents.get('codex', 'x1').status, 'done');
  assert.strictEqual(agents.get('codex', 'x1').lastMessage, 'this turn');
  assert.deepStrictEqual(alerts.map((a) => a.kind), ['done']);
});

test('codex: logs alone (no hooks) still show working and done', () => {
  const { agents, alerts, now } = make();
  agents.codexLog({ id: 'x2', cwd: '/w/site', project: 'site', title: 'make it pretty', last: { kind: 'started', at: now() } });
  assert.strictEqual(agents.get('codex', 'x2').status, 'working');
  agents.codexLog({ id: 'x2', last: { kind: 'complete', at: now.advance(1000), lastMessage: 'done' } });
  assert.strictEqual(agents.get('codex', 'x2').status, 'done');
  assert.deepStrictEqual(alerts.map((a) => a.kind), ['done']);
});

test('codex: history found at startup never alerts, and stale turns show idle', () => {
  const { agents, alerts, now } = make();
  agents.codexLog({ id: 'old', last: { kind: 'started', at: now() - 3 * 3600 * 1000 }, initial: true });
  agents.codexLog({ id: 'fin', last: { kind: 'complete', at: now() - 60000 }, initial: true });
  assert.strictEqual(agents.get('codex', 'old').status, 'idle');
  assert.strictEqual(agents.get('codex', 'fin').status, 'done');
  assert.strictEqual(alerts.length, 0);
});

test('codex: a turn read from the log is dated when it happened, not when honeybee read it', () => {
  const { agents, now } = make();
  const tenMinutesAgo = now() - 10 * 60 * 1000;
  // Found at startup: finished, stopped, stale, or with no turn yet.
  agents.codexLog({ id: 'fin', last: { kind: 'complete', at: tenMinutesAgo }, initial: true });
  agents.codexLog({ id: 'esc', last: { kind: 'aborted', at: tenMinutesAgo }, initial: true });
  agents.codexLog({ id: 'old', last: { kind: 'started', at: now() - 3 * 3600 * 1000 }, initial: true });
  agents.codexLog({ id: 'new', startedAt: tenMinutesAgo, initial: true });
  for (const id of ['fin', 'esc', 'new']) assert.strictEqual(agents.get('codex', id).statusSince, tenMinutesAgo, id);
  assert.strictEqual(agents.get('codex', 'old').statusSince, now() - 3 * 3600 * 1000);

  // Restored at restart as idle (it was mid-turn at quit), then the log says
  // the turn finished ten minutes ago.
  const before = new Agents({ now });
  before.codexLog({ id: 'mid', last: { kind: 'started', at: now() } });
  const saved = before.serialize();
  now.advance(20 * 60 * 1000);
  const finishedAt = now() - 10 * 60 * 1000;
  const restarted = new Agents({ now });
  restarted.restore(saved);
  assert.strictEqual(restarted.get('codex', 'mid').status, 'idle');
  restarted.codexLog({ id: 'mid', last: { kind: 'complete', at: finishedAt }, initial: true });
  assert.strictEqual(restarted.get('codex', 'mid').status, 'done');
  assert.strictEqual(restarted.get('codex', 'mid').statusSince, finishedAt);

  // Saved already "done" but dated by an earlier restart: the log corrects it.
  const misdated = new Agents({ now });
  misdated.restore([{ key: 'codex:old-done', agent: 'codex', id: 'old-done', status: 'done', statusSince: now(), updatedAt: now(), pending: [], via: {} }]);
  misdated.codexLog({ id: 'old-done', last: { kind: 'complete', at: finishedAt }, initial: true });
  assert.strictEqual(misdated.get('codex', 'old-done').statusSince, finishedAt);

  // A time in the future (a clock out of step) is never shown as ahead.
  agents.codexLog({ id: 'skew', last: { kind: 'complete', at: now() + 60000 } });
  assert.strictEqual(agents.get('codex', 'skew').statusSince, now());
});

test('list puts what needs you first; dismiss hides until the next event', () => {
  const { agents, now } = make();
  agents.claudeEvent(claude('UserPromptSubmit', { session_id: 'a' }));
  now.advance(1000);
  agents.claudeEvent(claude('Stop', { session_id: 'b' }));
  now.advance(1000);
  agents.claudeEvent(claude('UserPromptSubmit', { session_id: 'c' }));
  agents.claudeEvent(claude('PermissionRequest', { session_id: 'c', tool_name: 'Write', tool_use_id: 'w' }));
  assert.deepStrictEqual(agents.list().map((s) => s.id), ['c', 'a', 'b']);
  agents.dismiss('claude:b');
  assert.deepStrictEqual(agents.list().map((s) => s.id), ['c', 'a']);
  agents.claudeEvent(claude('UserPromptSubmit', { session_id: 'b' }));
  assert.ok(agents.list().some((s) => s.id === 'b'));
  assert.strictEqual(agents.counts()['needs-you'], 1);
});

test('expire forgets a day-old session; restore does not claim stale work', () => {
  const { agents, now } = make();
  agents.claudeEvent(claude('UserPromptSubmit'));
  const saved = agents.serialize();
  now.advance(10 * 60 * 1000);
  const fresh = new Agents({ now });
  fresh.restore(saved);
  assert.strictEqual(fresh.get('claude', 'c1').status, 'idle');
  now.advance(25 * 3600 * 1000);
  fresh.expire();
  assert.strictEqual(fresh.get('claude', 'c1'), null);
});

test('a seeded transcript session takes its state from the last turn', () => {
  const { agents, alerts, now } = make();
  agents.claudeSeed({ sessionId: 's1', transcriptPath: '/t', mtimeMs: now() - 10000, details: { title: 'Ship it', project: 'p', lastTurn: { kind: 'final' } } });
  agents.claudeSeed({ sessionId: 's2', transcriptPath: '/t', mtimeMs: now() - 10000, details: { title: null, project: 'p', lastTurn: { kind: 'tool' } } });
  agents.claudeSeed({ sessionId: 's3', transcriptPath: '/t', mtimeMs: now() - 3600000, details: { title: null, project: 'p', lastTurn: { kind: 'tool' } } });
  assert.strictEqual(agents.get('claude', 's1').status, 'done');
  assert.strictEqual(agents.get('claude', 's1').title, 'Ship it');
  assert.strictEqual(agents.get('claude', 's2').status, 'working');
  assert.strictEqual(agents.get('claude', 's3').status, 'idle');
  assert.strictEqual(alerts.length, 0);
});

test('status line context attaches to a known session only', () => {
  const { agents } = make();
  agents.claudeContext('c1', { contextPercent: 40, model: 'Opus', name: 'x' });
  assert.strictEqual(agents.get('claude', 'c1'), null);
  agents.claudeEvent(claude('UserPromptSubmit', { prompt: 'p' }));
  agents.claudeContext('c1', { contextPercent: 40, model: 'Opus', name: 'Named tab' });
  const s = agents.get('claude', 'c1');
  assert.strictEqual(s.contextPercent, 40);
  assert.strictEqual(s.title, 'Named tab');
});

test('tool labels read naturally', () => {
  assert.strictEqual(toolLabel('Bash'), 'a command');
  assert.strictEqual(toolLabel('apply_patch'), 'a file edit');
  assert.strictEqual(toolLabel('mcp__github__create_issue'), 'a github tool');
  assert.strictEqual(toolLabel(undefined), 'a tool');
});


test('claude: a subagent asking for approval makes the session need you', () => {
  const { agents, alerts } = make();
  agents.claudeEvent(claude('UserPromptSubmit'));
  agents.claudeEvent(claude('PermissionRequest', { agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'sub-tu' }));
  assert.strictEqual(agents.get('claude', 'c1').status, 'needs-you');
  agents.claudeEvent(claude('PostToolUse', { agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'sub-tu' }));
  assert.strictEqual(agents.get('claude', 'c1').status, 'working');
  agents.claudeEvent(claude('Stop', { agent_id: 'sub-1' }));
  assert.strictEqual(agents.get('claude', 'c1').status, 'working', 'a subagent stopping is not the session finishing');
  assert.deepStrictEqual(alerts.map((a) => a.kind), ['needs-you']);
});

test('claude: a wait recorded by id and by name is settled by the one tool result', () => {
  const { agents } = make();
  agents.claudeEvent(claude('UserPromptSubmit'));
  agents.claudeEvent(claude('PreToolUse', { tool_name: 'ExitPlanMode', tool_use_id: 'p1' }));
  agents.claudeEvent(claude('PermissionRequest', { tool_name: 'ExitPlanMode' }));
  agents.claudeEvent(claude('PostToolUse', { tool_name: 'ExitPlanMode', tool_use_id: 'p1' }));
  assert.strictEqual(agents.get('claude', 'c1').status, 'working');
});

test('a session that went silent is settled to idle instead of working all day', () => {
  const { agents, alerts, now } = make();
  agents.claudeEvent(claude('UserPromptSubmit'));
  now.advance(44 * 60 * 1000);
  agents.expire();
  assert.strictEqual(agents.get('claude', 'c1').status, 'working', 'a long tool run is still working');
  now.advance(2 * 60 * 1000);
  agents.expire();
  assert.strictEqual(agents.get('claude', 'c1').status, 'idle');
  agents.claudeEvent(claude('PostToolUse', { tool_name: 'Bash', tool_use_id: 'x' }));
  assert.strictEqual(agents.get('claude', 'c1').status, 'working', 'the next event brings it straight back');
  agents.claudeEvent(claude('PermissionRequest', { tool_name: 'Bash', tool_use_id: 'y' }));
  now.advance(5 * 3600 * 1000);
  agents.expire();
  assert.strictEqual(agents.get('claude', 'c1').status, 'needs-you', 'waiting for you can last hours');
  now.advance(2 * 3600 * 1000);
  agents.expire();
  assert.strictEqual(agents.get('claude', 'c1').status, 'idle');
  assert.deepStrictEqual(alerts.map((a) => a.kind), ['needs-you']);
});

run('agents');
