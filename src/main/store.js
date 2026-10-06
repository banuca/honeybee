'use strict';

// A small JSON file store. Writes go to a temporary file that is renamed over
// the real one, so a crash mid-write leaves the previous copy intact. A file
// that cannot be parsed is set aside (never deleted) and the store starts from
// its defaults.

const fs = require('fs');
const path = require('path');

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  return JSON.parse(text);
}

/**
 * Write JSON so that a crash can never leave a half-written file. The temp
 * file goes next to the REAL file, so a symlinked settings.json (dotfile
 * managers) keeps its link, and it gets the original's permissions, so a
 * private file stays private. New files are private by default.
 */
function writeJsonAtomic(file, data) {
  writeTextAtomic(file, JSON.stringify(data, null, 2) + '\n');
}

function writeTextAtomic(file, text) {
  let target = file;
  try { target = fs.realpathSync(file); } catch (_) { /* does not exist yet */ }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let mode = 0o600;
  try { mode = fs.statSync(target).mode & 0o777; } catch (_) { /* new file */ }
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, text, { encoding: 'utf8', mode });
  try {
    fs.chmodSync(temp, mode); // writeFileSync's mode is narrowed by the umask
  } catch (_) { /* best effort; Windows ignores it */ }
  try {
    renameWithRetry(temp, target);
  } catch (err) {
    try { fs.unlinkSync(temp); } catch (_) { /* already gone */ }
    throw err;
  }
}

// Windows refuses a rename while another process has the target open (an
// antivirus scan, or the agent reading its own settings). It clears quickly.
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= 19 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      const until = Date.now() + 25;
      while (Date.now() < until) { /* brief synchronous wait */ }
    }
  }
}

class JsonStore {
  constructor(file, defaults = {}) {
    this.file = file;
    this.defaults = defaults;
    this.data = structuredClone(defaults);
    this.timer = null;
    this.problem = null;
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const loaded = readJson(this.file);
      if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
        this.data = { ...structuredClone(this.defaults), ...loaded };
      }
    } catch (err) {
      const aside = `${this.file}.unreadable-${Date.now()}`;
      try { fs.renameSync(this.file, aside); } catch (_) { /* leave it */ }
      this.problem = `could not read ${path.basename(this.file)} (${err.message}); kept it as ${path.basename(aside)}`;
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.saveSoon();
  }

  update(key, patch) {
    this.set(key, { ...(this.data[key] || {}), ...patch });
  }

  saveSoon(delay = 250) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), delay);
    if (this.timer.unref) this.timer.unref();
  }

  saveNow() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      writeJsonAtomic(this.file, this.data);
      return true;
    } catch (err) {
      this.problem = `could not save ${path.basename(this.file)}: ${err.message}`;
      return false;
    }
  }
}

module.exports = { JsonStore, readJson, writeJsonAtomic, writeTextAtomic };
