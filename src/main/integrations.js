'use strict';

// Connecting honeybee to the agents by adding its hooks to their settings.
//
// These are the user's own files, so the rules are strict:
//   - a file that is not valid JSON is never touched;
//   - the original is kept once as <file>.before-honeybee, and the version
//     before every later change as <file>.honeybee-last;
//   - only honeybee's own entries are ever added or removed, recognised by
//     their URL and header, so every other hook survives exactly as it was;
//   - after writing, the file is read back and checked.
//
// Claude Code gets HTTP hooks (it posts each event straight to honeybee) and a
// status line command that forwards its rate-limit reading. Codex has no HTTP
// hooks, so it gets command hooks that hand the event to curl.

const fs = require('fs');
const { readJson, writeJsonAtomic } = require('./store');

const HEADER = 'X-Honeybee';

// Claude Code events honeybee listens to, with the matcher each needs.
// PreToolUse is narrowed to the two tools that wait for the user.
const CLAUDE_EVENTS = [
  ['UserPromptSubmit', null],
  ['PreToolUse', 'AskUserQuestion|ExitPlanMode'],
  ['PermissionRequest', null],
  ['PermissionDenied', null],
  ['PostToolUse', null],
  ['PostToolUseFailure', null],
  ['Notification', null],
  ['Stop', null],
  ['StopFailure', null],
  ['SessionEnd', null]
];

const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd'];

class IntegrationError extends Error {}

function url(port, route) {
  return `http://127.0.0.1:${port}${route}`;
}

/**
 * A curl invocation that posts stdin to honeybee. On Windows it names
 * curl.exe (PowerShell 5 aliases plain `curl` to something else) and quotes
 * "@-" (PowerShell reads a bare @ as splatting). The same string was checked to
 * pass stdin through in both Git Bash and Windows PowerShell 5.1.
 */
function curlCommand({ port, token, route, windows }) {
  const exe = windows ? 'curl.exe' : 'curl';
  return `${exe} -s -m 2 --connect-timeout 1 -H "${HEADER}: ${token}" -H "Content-Type: application/json" --data-binary "@-" ${url(port, route)}`;
}

// Recognised by URL AND header, so another local tool that happens to use the
// same route is never mistaken for honeybee. Any token counts, so hooks left
// by an earlier install are still found and replaced.
function isOurClaudeHook(h) {
  return Boolean(h && h.type === 'http' && typeof h.url === 'string'
    && /^http:\/\/127\.0\.0\.1:\d+\/claude\/hook$/.test(h.url)
    && h.headers && typeof h.headers[HEADER] === 'string');
}

function isOurCodexHook(h) {
  return Boolean(h && h.type === 'command' && typeof h.command === 'string'
    && h.command.includes('/codex/hook') && h.command.includes(HEADER));
}

function isOurStatusLine(sl) {
  return Boolean(sl && typeof sl.command === 'string'
    && sl.command.includes('/claude/statusline') && sl.command.includes(HEADER));
}

// The hooks of the earlier Python status widget, which honeybee replaces.
function isPythonWidgetHook(h) {
  return Boolean(h && Array.isArray(h.args) && h.args.length === 2 && h.args[1] === 'hook'
    && /claude_status_widget\.py$/i.test(String(h.args[0])));
}

function readSettings(file) {
  if (!fs.existsSync(file)) return { data: {}, existed: false };
  let data;
  try {
    data = readJson(file);
  } catch (err) {
    throw new IntegrationError(`${file} is not valid JSON (${err.message}), so honeybee left it untouched. Fix or remove it, then try again.`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new IntegrationError(`${file} does not contain a JSON object, so honeybee left it untouched.`);
  }
  return { data, existed: true };
}

function hooksOf(data, file) {
  if (data.hooks === undefined) return {};
  if (!data.hooks || typeof data.hooks !== 'object' || Array.isArray(data.hooks)) {
    throw new IntegrationError(`"hooks" in ${file} is not an object, so honeybee left the file untouched.`);
  }
  for (const [event, groups] of Object.entries(data.hooks)) {
    if (!Array.isArray(groups)) {
      throw new IntegrationError(`"hooks.${event}" in ${file} is not a list, so honeybee left the file untouched.`);
    }
  }
  return data.hooks;
}

/** Remove matching handlers from every event; drop groups and events left empty. */
function strip(hooks, predicate) {
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const kept = [];
    for (const group of hooks[event]) {
      if (group && Array.isArray(group.hooks)) {
        const others = group.hooks.filter((h) => !predicate(h));
        removed += group.hooks.length - others.length;
        if (others.length === 0) continue;
        kept.push(others.length === group.hooks.length ? group : { ...group, hooks: others });
      } else {
        kept.push(group);
      }
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  return removed;
}

function backup(file, existed) {
  if (!existed) return [];
  const made = [];
  const original = `${file}.before-honeybee`;
  if (!fs.existsSync(original)) {
    fs.copyFileSync(file, original);
    made.push(original);
  }
  const last = `${file}.honeybee-last`;
  fs.copyFileSync(file, last);
  made.push(last);
  return made;
}

function claudeStatusLine({ port, token, windows }) {
  return { type: 'command', command: curlCommand({ port, token, route: '/claude/statusline', windows }) };
}

function claudeHook({ port, token }) {
  return { type: 'http', url: url(port, '/claude/hook'), headers: { [HEADER]: token }, timeout: 3 };
}

/**
 * Add honeybee to Claude Code's settings.json.
 * @returns {{ backups: string[], replacedPythonWidget: number, statusLine: 'installed'|'replaced'|'kept-other', previousStatusLine: object|null }}
 */
function installClaude({ file, port, token, windows = process.platform === 'win32', replaceStatusLine = false }) {
  const { data, existed } = readSettings(file);
  const hooks = hooksOf(data, file);
  strip(hooks, isOurClaudeHook);
  const replacedPythonWidget = strip(hooks, isPythonWidgetHook);
  for (const [event, matcher] of CLAUDE_EVENTS) {
    const group = matcher ? { matcher, hooks: [claudeHook({ port, token })] } : { hooks: [claudeHook({ port, token })] };
    (hooks[event] = hooks[event] || []).push(group);
  }
  data.hooks = hooks;

  let statusLine = 'installed';
  let previousStatusLine = null;
  if (!data.statusLine || isOurStatusLine(data.statusLine)) {
    data.statusLine = claudeStatusLine({ port, token, windows });
  } else if (replaceStatusLine) {
    previousStatusLine = data.statusLine;
    data.statusLine = claudeStatusLine({ port, token, windows });
    statusLine = 'replaced';
  } else {
    statusLine = 'kept-other';
  }

  const backups = backup(file, existed);
  writeJsonAtomic(file, data);
  const check = checkClaude({ file, port, token });
  if (!check.hooks) throw new IntegrationError(`honeybee wrote ${file} but its hooks were not there when it read the file back.`);
  return { backups, replacedPythonWidget, statusLine, previousStatusLine };
}

/** Take honeybee out of Claude Code's settings, restoring a status line it replaced. */
function uninstallClaude({ file, previousStatusLine = null }) {
  const { data, existed } = readSettings(file);
  if (!existed) return { backups: [], removed: 0 };
  const hooks = hooksOf(data, file);
  const removed = strip(hooks, isOurClaudeHook);
  if (Object.keys(hooks).length) data.hooks = hooks;
  else delete data.hooks;
  if (isOurStatusLine(data.statusLine)) {
    if (previousStatusLine) data.statusLine = previousStatusLine;
    else delete data.statusLine;
  }
  const backups = backup(file, existed);
  writeJsonAtomic(file, data);
  return { backups, removed };
}

/** What Claude Code's settings currently say about honeybee. */
function checkClaude({ file, port, token }) {
  const result = { hooks: false, partial: false, current: false, statusLine: 'none', statusLineCurrent: false, pythonWidget: false, hooksDisabled: false, error: null };
  let data;
  try {
    ({ data } = readSettings(file));
  } catch (err) {
    result.error = err.message;
    return result;
  }
  let hooks = {};
  try { hooks = hooksOf(data, file); } catch (err) { result.error = err.message; return result; }
  const ours = (event) => (hooks[event] || []).flatMap((g) => (g && Array.isArray(g.hooks) ? g.hooks : [])).filter(isOurClaudeHook);
  const present = CLAUDE_EVENTS.filter(([event]) => ours(event).length > 0);
  result.hooks = present.length === CLAUDE_EVENTS.length;
  result.partial = present.length > 0 && !result.hooks;
  result.current = result.hooks && CLAUDE_EVENTS.every(([event]) => ours(event).some((h) =>
    h.url === url(port, '/claude/hook') && h.headers && h.headers[HEADER] === token));
  if (isOurStatusLine(data.statusLine)) {
    result.statusLine = 'ours';
    result.statusLineCurrent = data.statusLine.command.includes(`${HEADER}: ${token}`)
      && data.statusLine.command.includes(url(port, '/claude/statusline'));
  } else if (data.statusLine) {
    result.statusLine = 'other';
  }
  result.pythonWidget = Object.values(hooks).some((groups) => groups.some((g) => g && Array.isArray(g.hooks) && g.hooks.some(isPythonWidgetHook)));
  result.hooksDisabled = data.disableAllHooks === true;
  return result;
}

function codexHook({ port, token, event }) {
  const handler = {
    type: 'command',
    command: `${curlCommand({ port, token, route: '/codex/hook', windows: false })} >/dev/null 2>&1 || true`,
    commandWindows: curlCommand({ port, token, route: '/codex/hook', windows: true }),
    timeout: event === 'SessionEnd' ? 2 : 5
  };
  // In the background, so honeybee can never slow a turn down. Codex always
  // runs SessionEnd in the foreground, with a short timeout.
  if (event !== 'SessionEnd') handler.async = true;
  return handler;
}

/** Add honeybee to Codex's hooks.json. */
function installCodex({ file, port, token }) {
  const { data, existed } = readSettings(file);
  const hooks = hooksOf(data, file);
  strip(hooks, isOurCodexHook);
  for (const event of CODEX_EVENTS) {
    (hooks[event] = hooks[event] || []).push({ hooks: [codexHook({ port, token, event })] });
  }
  data.hooks = hooks;
  const backups = backup(file, existed);
  writeJsonAtomic(file, data);
  const check = checkCodex({ file, port, token });
  if (!check.hooks) throw new IntegrationError(`honeybee wrote ${file} but its hooks were not there when it read the file back.`);
  return { backups };
}

function uninstallCodex({ file }) {
  const { data, existed } = readSettings(file);
  if (!existed) return { backups: [], removed: 0 };
  const hooks = hooksOf(data, file);
  const removed = strip(hooks, isOurCodexHook);
  data.hooks = hooks;
  const backups = backup(file, existed);
  writeJsonAtomic(file, data);
  return { backups, removed };
}

function checkCodex({ file, port, token, configToml = null }) {
  const result = { hooks: false, partial: false, current: false, hooksDisabled: false, error: null };
  let data;
  try {
    ({ data } = readSettings(file));
  } catch (err) {
    result.error = err.message;
    return result;
  }
  let hooks = {};
  try { hooks = hooksOf(data, file); } catch (err) { result.error = err.message; return result; }
  const ours = (event) => (hooks[event] || []).flatMap((g) => (g && Array.isArray(g.hooks) ? g.hooks : [])).filter(isOurCodexHook);
  const present = CODEX_EVENTS.filter((event) => ours(event).length > 0);
  result.hooks = present.length === CODEX_EVENTS.length;
  result.partial = present.length > 0 && !result.hooks;
  result.current = result.hooks && CODEX_EVENTS.every((event) => ours(event).some((h) =>
    h.command.includes(`${HEADER}: ${token}`) && h.command.includes(url(port, '/codex/hook'))));
  if (configToml && fs.existsSync(configToml)) {
    try {
      const text = fs.readFileSync(configToml, 'utf8');
      const features = /^\s*\[features\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(text);
      result.hooksDisabled = Boolean(features && /^\s*hooks\s*=\s*false\b/m.test(features[1]));
    } catch (_) { /* advisory only */ }
  }
  return result;
}

module.exports = {
  HEADER,
  CLAUDE_EVENTS,
  CODEX_EVENTS,
  IntegrationError,
  curlCommand,
  installClaude,
  uninstallClaude,
  checkClaude,
  installCodex,
  uninstallCodex,
  checkCodex,
  isOurClaudeHook,
  isOurCodexHook,
  isOurStatusLine,
  isPythonWidgetHook
};
