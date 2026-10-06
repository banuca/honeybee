'use strict';

// Claude Code's "Use Terminal" setting in VS Code (and its relatives).
//
// Claude Code passes its usage limits to the status line, and runs the status
// line only in a terminal. The VS Code extension's graphical panel never does,
// so honeybee's Claude numbers go stale there. With `claudeCode.useTerminal`
// on, the extension opens Claude Code in VS Code's terminal instead, and every
// reply updates honeybee.
//
// settings.json is JSON with comments and trailing commas, and it is the
// user's own file, so the rules are those of integrations.js and then some:
//   - the file is edited as text, touching only this one setting, so every
//     comment, blank line and other setting stays exactly as it was;
//   - the edited text is parsed back, and it must hold the same settings as
//     before apart from this one, or nothing is written;
//   - the original is kept once as settings.json.before-honeybee, and the
//     version before every change as settings.json.honeybee-last.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeTextAtomic } = require('./store');

const KEY = 'claudeCode.useTerminal';

// Editors that take VS Code extensions: their settings folder and where their
// extensions live (honeybee only offers the switch where Claude Code is).
const EDITORS = [
  { name: 'VS Code', folder: 'Code', extensions: '.vscode' },
  { name: 'VS Code Insiders', folder: 'Code - Insiders', extensions: '.vscode-insiders' },
  { name: 'Cursor', folder: 'Cursor', extensions: '.cursor' },
  { name: 'Windsurf', folder: 'Windsurf', extensions: '.windsurf' }
];

function appDataDir(env, platform, home) {
  if (platform === 'win32') return env.APPDATA || path.join(home, 'AppData', 'Roaming');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  return env.XDG_CONFIG_HOME || path.join(home, '.config');
}

function hasClaudeCode(extensionsDir) {
  try { return fs.readdirSync(extensionsDir).some((n) => n.toLowerCase().startsWith('anthropic.claude-code-')); } catch (_) { return false; }
}

/** The editors on this computer that have the Claude Code extension. */
function findEditors({ env = process.env, platform = process.platform } = {}) {
  const home = env.HONEYBEE_HOME || os.homedir();
  const base = appDataDir(env, platform, home);
  const out = [];
  for (const e of EDITORS) {
    const userDir = path.join(base, e.folder, 'User');
    if (!hasClaudeCode(path.join(home, e.extensions, 'extensions'))) continue;
    if (!fs.existsSync(path.dirname(userDir))) continue;
    out.push({ name: e.name, file: path.join(userDir, 'settings.json') });
  }
  return out;
}

// ---- JSON with comments ----------------------------------------------------------

/** The text without comments and trailing commas: plain JSON. */
function stripJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === ',' && '}]'.includes(text[skip(text, i + 1)])) {
      i += 1; // a trailing comma
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function parseJsonc(text) {
  const value = JSON.parse(stripJsonc(text.replace(/^﻿/, '')) || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('settings.json is not an object');
  return value;
}

// Skip spaces and comments from i; returns the next index with real content.
function skip(text, i) {
  const n = text.length;
  for (;;) {
    while (i < n && /\s/.test(text[i])) i += 1;
    if (text[i] === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i += 1; continue; }
    if (text[i] === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
    return i;
  }
}

function stringEnd(text, i) {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
  return j + 1;
}

// The end of the value starting at i.
function valueEnd(text, i) {
  const c = text[i];
  if (c === '"') return stringEnd(text, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    let j = i;
    while (j < text.length) {
      j = skip(text, j);
      const d = text[j];
      if (d === '"') { j = stringEnd(text, j); continue; }
      if (d === '{' || d === '[') depth += 1;
      if (d === '}' || d === ']') { depth -= 1; if (depth === 0) return j + 1; }
      j += 1;
    }
    return j;
  }
  let j = i;
  while (j < text.length && /[A-Za-z0-9.+\-]/.test(text[j])) j += 1;
  return j;
}

/**
 * Where the top-level object starts, and each top-level setting's value.
 * @returns {{ open: number, members: {key: string, keyStart: number, valueStart: number, valueEnd: number}[] }}
 */
function topLevel(text) {
  let i = skip(text, text.charCodeAt(0) === 0xfeff ? 1 : 0);
  if (text[i] !== '{') throw new Error('settings.json does not start with {');
  const open = i;
  const members = [];
  i = skip(text, i + 1);
  while (i < text.length && text[i] !== '}') {
    if (text[i] !== '"') throw new Error('unexpected text in settings.json');
    const keyStart = i;
    const keyEnd = stringEnd(text, i);
    const key = JSON.parse(text.slice(keyStart, keyEnd));
    i = skip(text, keyEnd);
    if (text[i] !== ':') throw new Error('unexpected text in settings.json');
    const valueStart = skip(text, i + 1);
    const end = valueEnd(text, valueStart);
    members.push({ key, keyStart, valueStart, valueEnd: end });
    i = skip(text, end);
    if (text[i] === ',') i = skip(text, i + 1);
  }
  return { open, members };
}

/**
 * The same text with the setting at `on`. Only the setting's value changes,
 * or, when it is missing, one line is added as the first setting.
 */
function withUseTerminal(text, on) {
  const literal = on ? 'true' : 'false';
  if (!text.trim()) return `{\n    "${KEY}": ${literal}\n}\n`;
  const { open, members } = topLevel(text);
  const found = members.filter((m) => m.key === KEY).pop();
  if (found) return text.slice(0, found.valueStart) + literal + text.slice(found.valueEnd);
  const first = members[0];
  if (!first) {
    const close = skip(text, open + 1);
    return `${text.slice(0, open + 1)}\n    "${KEY}": ${literal}\n${text.slice(close)}`;
  }
  // Indent like the first setting already does.
  const lineStart = text.lastIndexOf('\n', first.keyStart) + 1;
  const lead = text.slice(lineStart, first.keyStart);
  const indent = /^[ \t]*$/.test(lead) && lead ? lead : '    ';
  return `${text.slice(0, open + 1)}\n${indent}"${KEY}": ${literal},${text.slice(open + 1)}`;
}

// ---- reading and writing -------------------------------------------------------

function readText(file) {
  try { return { text: fs.readFileSync(file, 'utf8'), existed: true }; } catch (err) {
    if (err.code === 'ENOENT') return { text: '', existed: false };
    throw err;
  }
}

/** One editor's state: is the setting on, or why it can't be read. */
function checkEditor(editor) {
  try {
    const { text } = readText(editor.file);
    const settings = text.trim() ? parseJsonc(text) : {};
    return { ...editor, useTerminal: settings[KEY] === true, error: null };
  } catch (err) {
    return { ...editor, useTerminal: false, error: `can't read ${editor.name}'s settings.json` };
  }
}

function sameExcept(a, b, key) {
  const strip = (o) => { const c = { ...o }; delete c[key]; return c; };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

function backup(file) {
  const made = [];
  const original = `${file}.before-honeybee`;
  if (!fs.existsSync(original)) {
    fs.copyFileSync(file, original);
    made.push(original);
  }
  fs.copyFileSync(file, `${file}.honeybee-last`);
  made.push(`${file}.honeybee-last`);
  return made;
}

/**
 * Turn the setting on or off in one editor's settings.json.
 * @returns {{ changed: boolean, backups: string[] }}
 */
function setEditor(editor, on) {
  const { text, existed } = readText(editor.file);
  const before = text.trim() ? parseJsonc(text) : {};
  if ((before[KEY] === true) === on) return { changed: false, backups: [] };
  const next = withUseTerminal(text, on);
  const after = parseJsonc(next);
  if (after[KEY] !== on || !sameExcept(before, after, KEY)) {
    throw new Error(`honeybee could not change ${editor.name}'s settings.json safely, so it was left as it was`);
  }
  const backups = existed ? backup(editor.file) : [];
  writeTextAtomic(editor.file, next);
  const check = parseJsonc(fs.readFileSync(editor.file, 'utf8'));
  if (check[KEY] !== on) throw new Error(`${editor.name}'s settings.json did not keep the change`);
  return { changed: true, backups };
}

/** The switch as the app shows it: on only when every editor has it on. */
function status(opts) {
  const editors = findEditors(opts).map(checkEditor);
  return {
    found: editors.length > 0,
    on: editors.length > 0 && editors.every((e) => e.useTerminal),
    editors
  };
}

/** Turn it on or off everywhere Claude Code is installed. */
function setAll(on, opts) {
  const results = [];
  for (const editor of findEditors(opts)) {
    try {
      results.push({ name: editor.name, ok: true, ...setEditor(editor, on) });
    } catch (err) {
      results.push({ name: editor.name, ok: false, message: err.message });
    }
  }
  const failed = results.filter((r) => !r.ok);
  return {
    ok: results.length > 0 && failed.length === 0,
    message: !results.length ? 'Claude Code isn\'t installed in VS Code on this computer.' : failed.map((r) => r.message).join(' '),
    results
  };
}

module.exports = { KEY, findEditors, stripJsonc, parseJsonc, withUseTerminal, setEditor, checkEditor, status, setAll };
