'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run, tempDir } = require('./harness');
const integ = require('../src/main/integrations');

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const TOKEN = 'a'.repeat(48);

// The user's real shape: their own hooks, the old Python widget's hooks, other settings.
function userSettings() {
  return {
    model: 'opus',
    permissions: { allow: ['Bash(git status)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/guard.sh' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'C:\\Python312\\python.exe', args: ['C:\\fun\\claude_status_widget.py', 'hook'] }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'C:\\Python312\\python.exe', args: ['C:\\fun\\claude_status_widget.py', 'hook'] }] }]
    }
  };
}

test('claude: install adds every hook and the status line, keeps the user\'s own, replaces the Python widget', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(userSettings(), null, 2));
  const result = integ.installClaude({ file, port: 47621, token: TOKEN, windows: true });
  const data = read(file);
  assert.strictEqual(data.model, 'opus');
  assert.deepStrictEqual(data.permissions, { allow: ['Bash(git status)'] });
  assert.ok(data.hooks.PreToolUse.some((g) => g.matcher === 'Bash' && g.hooks[0].command === '~/guard.sh'), 'user hook kept');
  assert.strictEqual(result.replacedPythonWidget, 2);
  assert.strictEqual(data.hooks.SessionStart, undefined, 'an event left empty is removed');
  for (const [event] of integ.CLAUDE_EVENTS) {
    const ours = data.hooks[event].flatMap((g) => g.hooks).filter(integ.isOurClaudeHook);
    assert.strictEqual(ours.length, 1, event);
    assert.strictEqual(ours[0].url, 'http://127.0.0.1:47621/claude/hook');
    assert.strictEqual(ours[0].headers[integ.HEADER], TOKEN);
  }
  assert.ok(data.statusLine.command.startsWith('curl.exe '));
  assert.ok(data.statusLine.command.includes('"@-"'));
  assert.strictEqual(result.statusLine, 'installed');
  assert.ok(fs.existsSync(`${file}.before-honeybee`));
  assert.deepStrictEqual(read(`${file}.before-honeybee`), userSettings(), 'the original is kept as it was');
  const check = integ.checkClaude({ file, port: 47621, token: TOKEN });
  assert.strictEqual(check.hooks && check.current && check.statusLineCurrent, true);
  assert.strictEqual(check.pythonWidget, false);
});

test('claude: installing twice, or on a new port, leaves exactly one set', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  integ.installClaude({ file, port: 47621, token: TOKEN, windows: false });
  integ.installClaude({ file, port: 47622, token: TOKEN, windows: false });
  const data = read(file);
  for (const [event] of integ.CLAUDE_EVENTS) {
    const ours = data.hooks[event].flatMap((g) => g.hooks).filter(integ.isOurClaudeHook);
    assert.strictEqual(ours.length, 1, event);
    assert.ok(ours[0].url.includes(':47622/'));
  }
  assert.ok(data.statusLine.command.startsWith('curl '));
  assert.strictEqual(integ.checkClaude({ file, port: 47621, token: TOKEN }).current, false, 'an old port is reported');
});

test('claude: someone else\'s status line is kept unless replacing is asked for, and restored on disconnect', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  const theirs = { type: 'command', command: '~/.claude/statusline.sh', padding: 2 };
  fs.writeFileSync(file, JSON.stringify({ statusLine: theirs }));
  assert.strictEqual(integ.installClaude({ file, port: 1, token: TOKEN }).statusLine, 'kept-other');
  assert.deepStrictEqual(read(file).statusLine, theirs);
  const replaced = integ.installClaude({ file, port: 1, token: TOKEN, replaceStatusLine: true });
  assert.strictEqual(replaced.statusLine, 'replaced');
  assert.deepStrictEqual(replaced.previousStatusLine, theirs);
  integ.uninstallClaude({ file, previousStatusLine: replaced.previousStatusLine });
  const after = read(file);
  assert.deepStrictEqual(after.statusLine, theirs);
  assert.strictEqual(after.hooks, undefined, 'nothing of honeybee is left');
});

test('claude: disconnect leaves the user\'s hooks alone', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(userSettings()));
  integ.installClaude({ file, port: 9, token: TOKEN });
  integ.uninstallClaude({ file });
  const data = read(file);
  assert.ok(data.hooks.PreToolUse[0].hooks[0].command === '~/guard.sh');
  assert.strictEqual(data.statusLine, undefined);
  assert.ok(!JSON.stringify(data).includes('/claude/hook'));
});

test('a settings file that is not valid JSON is never touched', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{ "model": "opus", ');
  assert.throws(() => integ.installClaude({ file, port: 1, token: TOKEN }), integ.IntegrationError);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ "model": "opus", ');
  assert.ok(!fs.existsSync(`${file}.before-honeybee`));
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: { not: 'a list' } } }));
  assert.throws(() => integ.installClaude({ file, port: 1, token: TOKEN }), /not a list/);
});

test('a settings file that does not exist yet is created', () => {
  const dir = tempDir();
  const file = path.join(dir, 'nested', 'settings.json');
  const result = integ.installClaude({ file, port: 5, token: TOKEN });
  assert.deepStrictEqual(result.backups, []);
  assert.ok(integ.checkClaude({ file, port: 5, token: TOKEN }).hooks);
});

test('codex: install writes background curl hooks for every event, idempotently', () => {
  const dir = tempDir();
  const file = path.join(dir, 'hooks.json');
  fs.writeFileSync(file, JSON.stringify({ description: 'mine', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 x.py' }] }] } }));
  integ.installCodex({ file, port: 47621, token: TOKEN });
  integ.installCodex({ file, port: 47621, token: TOKEN });
  const data = read(file);
  assert.strictEqual(data.description, 'mine');
  assert.strictEqual(data.hooks.PreToolUse[0].hooks[0].command, 'python3 x.py');
  for (const event of integ.CODEX_EVENTS) {
    const ours = data.hooks[event].flatMap((g) => g.hooks).filter(integ.isOurCodexHook);
    assert.strictEqual(ours.length, 1, event);
    assert.ok(ours[0].command.startsWith('curl '));
    assert.ok(ours[0].command.endsWith('|| true'));
    assert.ok(ours[0].commandWindows.startsWith('curl.exe '));
    assert.strictEqual(ours[0].async, event === 'SessionEnd' ? undefined : true);
  }
  assert.ok(integ.checkCodex({ file, port: 47621, token: TOKEN }).current);
  integ.uninstallCodex({ file });
  const after = read(file);
  assert.ok(!JSON.stringify(after).includes('/codex/hook'));
  assert.strictEqual(after.hooks.PreToolUse[0].hooks[0].command, 'python3 x.py');
});

test('codex: hooks switched off in config.toml are reported', () => {
  const dir = tempDir();
  const toml = path.join(dir, 'config.toml');
  fs.writeFileSync(toml, 'model = "x"\n[features]\nmemories = true\nhooks = false\n[mcp_servers.a]\ncommand = "b"\n');
  assert.strictEqual(integ.checkCodex({ file: path.join(dir, 'hooks.json'), port: 1, token: TOKEN, configToml: toml }).hooksDisabled, true);
  fs.writeFileSync(toml, '[features]\nhooks = true\n');
  assert.strictEqual(integ.checkCodex({ file: path.join(dir, 'hooks.json'), port: 1, token: TOKEN, configToml: toml }).hooksDisabled, false);
});

test('the curl command differs on Windows exactly where it must', () => {
  const unix = integ.curlCommand({ port: 1, token: 't', route: '/r', windows: false });
  const win = integ.curlCommand({ port: 1, token: 't', route: '/r', windows: true });
  assert.strictEqual(win, unix.replace(/^curl /, 'curl.exe '));
  assert.ok(unix.includes('-H "X-Honeybee: t"'));
});

test('a hook from another tool on the same route is never taken for honeybee', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  const other = { type: 'http', url: 'http://127.0.0.1:9999/claude/hook' };
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [other] }] } }));
  integ.installClaude({ file, port: 47621, token: TOKEN });
  integ.uninstallClaude({ file });
  assert.deepStrictEqual(read(file).hooks.Stop[0].hooks[0], other);
});

test('writing keeps a symlinked settings file linked, and its permissions', () => {
  const dir = tempDir();
  const real = path.join(dir, 'dotfiles-settings.json');
  const link = path.join(dir, 'settings.json');
  fs.writeFileSync(real, JSON.stringify({ model: 'opus' }));
  if (process.platform !== 'win32') fs.chmodSync(real, 0o600);
  let linked = true;
  try { fs.symlinkSync(real, link); } catch (_) { linked = false; } // Windows needs a privilege for symlinks
  const target = linked ? link : real;
  integ.installClaude({ file: target, port: 1, token: TOKEN });
  if (linked) {
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'still a link');
    assert.ok(read(real).hooks, 'the real file got the hooks');
  }
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(real).mode & 0o777, 0o600);
});

run('integrations');
