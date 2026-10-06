'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run, tempDir } = require('./harness');
const vs = require('../src/main/vscode-settings');

const KEY = 'claudeCode.useTerminal';

// A settings file the way people really keep them: comments, trailing
// commas, nested objects, strings that look like syntax.
const MESSY = `// my settings
{
    "editor.fontSize": 14, // big enough
    /* block
       comment { } , */
    "files.exclude": {
        "**/.git": true,
    },
    "url": "http://example.com/a,}b",
    "claudeCode.preferredLocation": "panel",
}
`;

function editorHome({ settings = null, claude = true } = {}) {
  const home = tempDir();
  const appData = path.join(home, 'AppData', 'Roaming');
  const userDir = path.join(appData, 'Code', 'User');
  fs.mkdirSync(userDir, { recursive: true });
  if (settings !== null) fs.writeFileSync(path.join(userDir, 'settings.json'), settings);
  if (claude) fs.mkdirSync(path.join(home, '.vscode', 'extensions', 'anthropic.claude-code-2.1.291-win32-x64'), { recursive: true });
  return { env: { HONEYBEE_HOME: home, APPDATA: appData }, platform: 'win32', file: path.join(userDir, 'settings.json') };
}

test('comments and trailing commas are read, strings are left alone', () => {
  const parsed = vs.parseJsonc(MESSY);
  assert.strictEqual(parsed['editor.fontSize'], 14);
  assert.strictEqual(parsed.url, 'http://example.com/a,}b');
  assert.deepStrictEqual(parsed['files.exclude'], { '**/.git': true });
});

test('a missing setting is added as one line; everything else is byte for byte the same', () => {
  const next = vs.withUseTerminal(MESSY, true);
  assert.strictEqual(vs.parseJsonc(next)[KEY], true);
  const added = `\n    "${KEY}": true,`;
  assert.strictEqual(next.replace(added, ''), MESSY);
});

test('an existing setting has only its value changed', () => {
  const text = `{\n  "a": 1,\n  "${KEY}": false, // mine\n  "b": [1, 2]\n}\n`;
  const next = vs.withUseTerminal(text, true);
  assert.strictEqual(next, text.replace(`"${KEY}": false`, `"${KEY}": true`));
  assert.strictEqual(vs.withUseTerminal(next, false), text);
});

test('an empty object, an empty file and a BOM are all handled', () => {
  assert.strictEqual(vs.parseJsonc(vs.withUseTerminal('{}', true))[KEY], true);
  assert.strictEqual(vs.parseJsonc(vs.withUseTerminal('', true))[KEY], true);
  assert.strictEqual(vs.parseJsonc(vs.withUseTerminal('﻿{\n\t"a": 1\n}', true))[KEY], true);
  assert.ok(vs.withUseTerminal('{\n\t"a": 1\n}', true).includes(`\n\t"${KEY}": true,\n\t"a": 1`), 'tabs are kept as the indent');
});

test('turning it on backs the file up once, writes, and reads back', () => {
  const ed = editorHome({ settings: MESSY });
  const editors = vs.findEditors(ed);
  assert.deepStrictEqual(editors.map((e) => e.name), ['VS Code']);
  const result = vs.setAll(true, ed);
  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(vs.parseJsonc(fs.readFileSync(ed.file, 'utf8'))[KEY], true);
  assert.strictEqual(fs.readFileSync(`${ed.file}.before-honeybee`, 'utf8'), MESSY);
  assert.strictEqual(vs.status(ed).on, true);

  // Off again: only the value changes; the first backup stays the original.
  assert.strictEqual(vs.setAll(false, ed).ok, true);
  assert.strictEqual(vs.status(ed).on, false);
  assert.strictEqual(fs.readFileSync(`${ed.file}.before-honeybee`, 'utf8'), MESSY);
  assert.strictEqual(fs.readFileSync(`${ed.file}.honeybee-last`, 'utf8').includes(`"${KEY}": true`), true);
});

test('already on: nothing is written', () => {
  const ed = editorHome({ settings: `{ "${KEY}": true }` });
  const result = vs.setAll(true, ed);
  assert.strictEqual(result.results[0].changed, false);
  assert.strictEqual(fs.existsSync(`${ed.file}.before-honeybee`), false);
});

test('no settings.json yet: one is made', () => {
  const ed = editorHome();
  assert.strictEqual(vs.setAll(true, ed).ok, true);
  assert.strictEqual(vs.parseJsonc(fs.readFileSync(ed.file, 'utf8'))[KEY], true);
});

test('a broken settings.json is never touched', () => {
  const broken = '{ "a": 1 "b": 2 }';
  const ed = editorHome({ settings: broken });
  const result = vs.setAll(true, ed);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(fs.readFileSync(ed.file, 'utf8'), broken);
  assert.ok(vs.status(ed).editors[0].error);
});

test('an editor without Claude Code is not offered', () => {
  const ed = editorHome({ settings: '{}', claude: false });
  assert.strictEqual(vs.status(ed).found, false);
  assert.strictEqual(vs.setAll(true, ed).ok, false);
});

test('the real VS Code settings.json on this computer (a copy) survives the edit', () => {
  const real = path.join(process.env.APPDATA || '', 'Code', 'User', 'settings.json');
  if (!process.env.APPDATA || !fs.existsSync(real)) return;
  const text = fs.readFileSync(real, 'utf8');
  const before = vs.parseJsonc(text);
  const after = vs.parseJsonc(vs.withUseTerminal(text, !(before[KEY] === true)));
  delete before[KEY];
  delete after[KEY];
  assert.deepStrictEqual(after, before);
});

run('vscode-settings');
