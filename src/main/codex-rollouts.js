'use strict';

// Following Codex's own session logs ("rollouts").
//
// Codex writes every conversation to ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// as it happens. Two things come out of them, without any sign-in:
//
//   - each session's state: a turn started, finished, or was interrupted;
//   - the rate limits Codex was told about on its last turn (token_count
//     events carry rate_limits.primary / secondary).
//
// Files are tailed by byte offset, so a long session costs only the bytes it
// appends.

const fs = require('fs');
const path = require('path');

const HEAD = 64 * 1024;
const TAIL = 256 * 1024;

function toMs(seconds) {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : null;
}

function oneLine(value, max = 80) {
  return String(value).split(/\s+/).filter(Boolean).join(' ').slice(0, max);
}

// The first user messages Codex records are its own context blocks
// (<environment_context>, AGENTS.md instructions, plugin lists), not prompts.
function isRealPrompt(text) {
  const t = String(text || '').trim();
  return t.length > 0 && !t.startsWith('<') && !t.startsWith('# AGENTS.md');
}

function parseWindow(raw, observedAt) {
  if (!raw || typeof raw !== 'object') return null;
  const used = Number(raw.used_percent);
  if (!Number.isFinite(used)) return null;
  let resetsAt = toMs(raw.resets_at);
  if (resetsAt === null && typeof raw.resets_in_seconds === 'number' && observedAt) {
    resetsAt = observedAt + raw.resets_in_seconds * 1000;
  }
  return {
    usedPercent: Math.max(0, Math.min(100, used)),
    windowMinutes: Number.isFinite(Number(raw.window_minutes)) ? Number(raw.window_minutes) : null,
    resetsAt
  };
}

function parseRateLimits(raw, observedAt) {
  if (!raw || typeof raw !== 'object') return null;
  const primary = parseWindow(raw.primary, observedAt);
  const secondary = parseWindow(raw.secondary, observedAt);
  if (!primary && !secondary) return null;
  return {
    limitId: typeof raw.limit_id === 'string' ? raw.limit_id : null,
    planType: typeof raw.plan_type === 'string' ? raw.plan_type : null,
    primary,
    secondary,
    reached: typeof raw.rate_limit_reached_type === 'string' ? raw.rate_limit_reached_type : null,
    observedAt
  };
}

/**
 * Fold one rollout line into a file's state. Returns what changed:
 * { session: bool, usage: snapshot|null }.
 */
function applyLine(state, line) {
  let entry;
  try { entry = JSON.parse(line); } catch (_) { return null; }
  if (!entry || typeof entry !== 'object') return null;
  const at = Date.parse(entry.timestamp) || null;
  const p = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
  const change = { session: false, usage: null };

  if (entry.type === 'session_meta') {
    state.id = p.id || p.session_id || state.id;
    if (typeof p.cwd === 'string') state.cwd = p.cwd;
    state.originator = p.originator || state.originator || null;
    state.startedAt = Date.parse(p.timestamp) || at || state.startedAt;
    change.session = true;
  } else if (entry.type === 'turn_context') {
    if (typeof p.cwd === 'string' && p.cwd !== state.cwd) {
      state.cwd = p.cwd;
      change.session = true;
    }
  } else if (entry.type === 'response_item' && p.type === 'message' && p.role === 'user' && !state.title) {
    const part = (Array.isArray(p.content) ? p.content : [])
      .find((c) => c && typeof c.text === 'string' && isRealPrompt(c.text));
    if (part) {
      state.title = oneLine(part.text);
      change.session = true;
    }
  } else if (entry.type === 'event_msg') {
    switch (p.type) {
      case 'task_started':
        state.last = { kind: 'started', at: toMs(p.started_at) || at, turnId: p.turn_id || null };
        change.session = true;
        break;
      case 'task_complete':
        state.last = {
          kind: 'complete',
          at: toMs(p.completed_at) || at,
          turnId: p.turn_id || null,
          lastMessage: typeof p.last_agent_message === 'string' ? oneLine(p.last_agent_message, 140) : null
        };
        change.session = true;
        break;
      case 'turn_aborted':
        state.last = { kind: 'aborted', at, turnId: p.turn_id || null, reason: p.reason || null };
        change.session = true;
        break;
      case 'user_message':
        if (!state.title && isRealPrompt(p.message)) {
          state.title = oneLine(p.message);
          change.session = true;
        }
        break;
      case 'token_count': {
        const snapshot = parseRateLimits(p.rate_limits, at);
        if (snapshot) change.usage = snapshot;
        break;
      }
      default:
        if (/thread_name|thread_renamed/.test(String(p.type)) && typeof (p.thread_name || p.name) === 'string') {
          state.title = oneLine(p.thread_name || p.name);
          change.session = true;
        }
    }
  }
  return change;
}

function readBytes(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

// Split bytes into the complete lines and the unfinished rest. Done on bytes,
// not text, so a character Codex has only half-written is never mangled.
function completeLines(buf) {
  const nl = buf.lastIndexOf(0x0a);
  if (nl < 0) return { lines: [], rest: Buffer.from(buf) };
  return { lines: buf.subarray(0, nl).toString('utf8').split('\n'), rest: Buffer.from(buf.subarray(nl + 1)) };
}

// Day folders, newest first, for the last `days` days.
function dayFolders(sessionsDir, nowMs, days) {
  const folders = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(nowMs - i * 86400000);
    const y = String(d.getFullYear());
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    folders.push(path.join(sessionsDir, y, m, day));
  }
  return folders;
}

class CodexRollouts {
  /**
   * @param {object} opts
   * @param {string} opts.sessionsDir
   * @param {(s: object) => void} opts.onSession  session state changed
   * @param {(u: object) => void} opts.onUsage    newer rate limits seen
   * @param {number} [opts.activeWindowMs]        sessions older than this are not reported at startup
   */
  constructor({ sessionsDir, onSession, onUsage, now = Date.now, activeWindowMs = 12 * 3600 * 1000 }) {
    this.sessionsDir = sessionsDir;
    this.onSession = onSession;
    this.onUsage = onUsage;
    this.now = now;
    this.activeWindowMs = activeWindowMs;
    this.files = new Map(); // file -> { offset, carry, state }
    this.latestUsage = null;
    this.timers = [];
  }

  start({ pollMs = 1500, discoverMs = 5000 } = {}) {
    this.scanInitial();
    this.timers.push(setInterval(() => this.pollKnown(), pollMs));
    this.timers.push(setInterval(() => this.discover(false), discoverMs));
    for (const t of this.timers) if (t.unref) t.unref();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  listRollouts(days) {
    const out = [];
    for (const folder of dayFolders(this.sessionsDir, this.now(), days)) {
      let names;
      try { names = fs.readdirSync(folder); } catch (_) { continue; }
      for (const name of names) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
        const file = path.join(folder, name);
        try {
          const stat = fs.statSync(file);
          out.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch (_) { /* vanished */ }
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  // On start: sessions active recently, and the newest rate limits within the
  // last week (a weekly window can still be meaningful that long).
  scanInitial() {
    const cutoff = this.now() - this.activeWindowMs;
    const all = this.listRollouts(8);
    for (const info of all) {
      if (info.mtimeMs >= cutoff) this.track(info, true);
    }
    if (!this.latestUsage) {
      for (const info of all.slice(0, 40)) {
        if (this.files.has(info.file)) continue;
        const usage = this.lastUsageIn(info);
        if (usage) {
          this.offerUsage(usage);
          break;
        }
      }
    }
  }

  // A resumed session keeps writing to its file in the day folder where it
  // started, so look back as far as the start-up scan does.
  discover(initial) {
    for (const info of this.listRollouts(8)) {
      if (!this.files.has(info.file) && info.mtimeMs >= this.now() - this.activeWindowMs) {
        this.track(info, initial);
      }
    }
  }

  // Read a file's head (identity, title) and tail (latest state) once, then
  // follow it from its current end.
  track(info, initial) {
    const state = { id: null, cwd: null, originator: null, title: null, last: null, startedAt: null };
    const record = { offset: info.size, carry: Buffer.alloc(0), state, file: info.file, mtimeMs: info.mtimeMs };
    this.files.set(info.file, record);
    try {
      let bytes;
      if (info.size <= HEAD + TAIL) {
        bytes = readBytes(info.file, 0, info.size);
      } else {
        // Identity and title come from the head; usage there is older than
        // anything in the tail, so it is ignored.
        for (const line of completeLines(readBytes(info.file, 0, HEAD)).lines) applyLine(state, line);
        bytes = readBytes(info.file, info.size - TAIL, TAIL);
      }
      const { lines, rest } = completeLines(bytes);
      // A line Codex is still writing is kept back and completed on the next poll.
      record.carry = rest;
      for (const line of lines) {
        const change = applyLine(state, line);
        if (change && change.usage) this.offerUsage(change.usage);
      }
    } catch (_) {
      return;
    }
    if (state.id) this.emit(record, initial);
  }

  lastUsageIn(info) {
    try {
      const start = Math.max(0, info.size - TAIL);
      let found = null;
      for (const line of completeLines(readBytes(info.file, start, info.size - start)).lines) {
        if (!line.includes('"token_count"')) continue;
        const change = applyLine({}, line);
        if (change && change.usage) found = change.usage;
      }
      return found;
    } catch (_) {
      return null;
    }
  }

  pollKnown() {
    for (const record of [...this.files.values()]) {
      let stat;
      try { stat = fs.statSync(record.file); } catch (_) {
        this.files.delete(record.file);
        continue;
      }
      const size = stat.size;
      if (size < record.offset) {
        // Rewritten from scratch (a migration or a fork): start over.
        this.files.delete(record.file);
        this.track({ file: record.file, size, mtimeMs: stat.mtimeMs }, false);
        continue;
      }
      if (size === record.offset) {
        // Quiet for longer than the active window: stop following it. If the
        // session is resumed, discover() picks the file up again.
        if (this.now() - stat.mtimeMs > this.activeWindowMs) this.files.delete(record.file);
        continue;
      }
      let fresh;
      try { fresh = readBytes(record.file, record.offset, size - record.offset); } catch (_) { continue; }
      record.offset = size;
      const { lines, rest } = completeLines(Buffer.concat([record.carry, fresh]));
      record.carry = rest;
      let sessionChanged = false;
      for (const line of lines) {
        const change = applyLine(record.state, line);
        if (!change) continue;
        if (change.session) sessionChanged = true;
        if (change.usage) this.offerUsage(change.usage);
      }
      if (sessionChanged && record.state.id) this.emit(record, false);
    }
  }

  offerUsage(usage) {
    const current = this.latestUsage;
    if (current && (current.observedAt || 0) > (usage.observedAt || 0)) return;
    this.latestUsage = usage;
    this.onUsage(usage);
  }

  emit(record, initial) {
    const s = record.state;
    this.onSession({
      id: s.id,
      cwd: s.cwd,
      project: s.cwd ? s.cwd.split(/[\\/]/).filter(Boolean).pop() || s.cwd : null,
      title: s.title,
      originator: s.originator,
      last: s.last,
      startedAt: s.startedAt,
      transcriptPath: record.file,
      initial
    });
  }
}

module.exports = { CodexRollouts, applyLine, parseRateLimits, isRealPrompt, dayFolders };
