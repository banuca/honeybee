'use strict';

// Reading what a Claude Code transcript says about its session: the tab's
// name, the project folder it was opened in, and where the last turn ended.
//
// Transcripts can be many megabytes, so only the head and the tail are read.
// The naming order matches the VS Code extension's: your rename, then
// Claude's own title, then your last message.

const fs = require('fs');
const path = require('path');

const CHUNK = 256 * 1024;
const TAIL = 64 * 1024;
const INTERRUPTED = '[Request interrupted by user';

function readSlices(file, headBytes, tailBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const slices = [];
    if (headBytes > 0) {
      const head = Buffer.alloc(Math.min(headBytes, size));
      fs.readSync(fd, head, 0, head.length, 0);
      slices.push(head.toString('utf8'));
    }
    if (size > headBytes) {
      const length = Math.min(tailBytes, size);
      const tail = Buffer.alloc(length);
      fs.readSync(fd, tail, 0, length, size - length);
      slices.push(tail.toString('utf8'));
    }
    return slices;
  } finally {
    fs.closeSync(fd);
  }
}

// Parse the lines of a slice that contain one of the markers. A line cut in
// half at a slice edge simply fails to parse and is skipped.
function* entries(text, markers) {
  for (const line of text.split('\n')) {
    if (markers && !markers.some((m) => line.includes(m))) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object') yield entry;
    } catch (_) { /* partial line */ }
  }
}

function lastOf(text, markers, predicate) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (markers && !markers.some((m) => line.includes(m))) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    if (entry && typeof entry === 'object' && predicate(entry)) return entry;
  }
  return null;
}

function oneLine(value, max = 80) {
  return String(value).split(/\s+/).filter(Boolean).join(' ').slice(0, max);
}

function contentParts(entry) {
  const content = entry && entry.message && entry.message.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function isInterruption(entry) {
  return entry.type === 'user' && contentParts(entry).some((part) =>
    part && part.type === 'text' && String(part.text || '').startsWith(INTERRUPTED));
}

// How the last main-conversation turn ended.
//   final        Claude finished answering
//   tool         Claude asked for a tool and is waiting on it (or on you)
//   tool_result  a tool returned and Claude is thinking again
//   prompt       you sent a message
//   interrupted  you pressed Esc, or rejected an approval
// Claude Code writes each part of a reply (thinking, text, tool call) as its
// own line, all carrying the reply's stop_reason. Only "end_turn" (and its
// siblings) means Claude has finished; a text line that says "Let me check"
// carries "tool_use", because a tool call follows it.
const FINISHED = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);

function describeTurn(entry) {
  if (!entry) return null;
  const at = Date.parse(entry.timestamp) || null;
  if (entry.type === 'assistant') {
    const parts = contentParts(entry);
    const stop = entry.message ? entry.message.stop_reason : undefined;
    const usesTool = parts.some((part) => part && part.type === 'tool_use');
    // Older transcripts have no stop_reason at all; then a tool call is the only clue.
    const finished = stop === undefined ? !usesTool : FINISHED.has(stop);
    if (!finished) return { kind: 'tool', at };
    const text = parts.find((part) => part && part.type === 'text' && String(part.text || '').trim());
    return { kind: 'final', at, text: text ? oneLine(text.text, 140) : null };
  }
  if (isInterruption(entry)) return { kind: 'interrupted', at };
  const isToolResult = contentParts(entry).some((part) => part && part.type === 'tool_result');
  return { kind: isToolResult ? 'tool_result' : 'prompt', at };
}

/**
 * The folder the tab was opened in. Claude Code names each transcript folder
 * after it (every non-alphanumeric character becomes "-"), so walk up from the
 * latest working directory until a folder produces that slug.
 */
function projectFolder(transcriptPath, cwd) {
  if (!cwd) return null;
  const slug = path.basename(path.dirname(transcriptPath)).toLowerCase();
  // Not path.resolve: that would prefix a drive letter and change the slug.
  let folder = String(cwd).replace(/(.)[\\/]+$/, '$1');
  for (;;) {
    if (folder.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase() === slug) {
      return path.basename(folder) || folder;
    }
    const parent = path.dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
}

function isMainTurn(entry) {
  return (entry.type === 'user' || entry.type === 'assistant') && !entry.isSidechain;
}

/** Everything the widget shows about a session, from its transcript. */
function readTranscript(transcriptPath) {
  let slices;
  try {
    slices = readSlices(transcriptPath, CHUNK, CHUNK);
  } catch (_) {
    return null;
  }
  const names = {};
  // The tail is read last, so its newer names win.
  for (const slice of slices) {
    for (const entry of entries(slice, ['-title"', '"last-prompt"'])) {
      for (const [kind, key] of [['custom-title', 'customTitle'], ['ai-title', 'aiTitle'], ['last-prompt', 'lastPrompt']]) {
        const value = entry[key];
        if (entry.type === kind && typeof value === 'string' && value.trim()) names[kind] = oneLine(value);
      }
    }
  }
  const tail = slices[slices.length - 1];
  // Claude may have moved into a subfolder, so start from the latest one.
  const withCwd = lastOf(tail, ['"cwd":"'], (e) => typeof e.cwd === 'string' && e.cwd);
  const cwd = withCwd ? withCwd.cwd : null;
  const lastTurn = describeTurn(lastOf(tail, ['"type":"user"', '"type":"assistant"'], isMainTurn));
  return {
    title: names['custom-title'] || names['ai-title'] || names['last-prompt'] || null,
    project: projectFolder(transcriptPath, cwd) || (cwd ? path.basename(cwd) : null),
    cwd,
    lastTurn
  };
}

/** Cheap check of just the end of a transcript: how did the last turn end? */
function readLastTurn(transcriptPath) {
  try {
    const [tail = ''] = readSlices(transcriptPath, 0, TAIL);
    return describeTurn(lastOf(tail, ['"type":"user"', '"type":"assistant"'], isMainTurn));
  } catch (_) {
    return null;
  }
}

/**
 * Transcripts touched recently, newest first: the sessions worth showing on a
 * fresh start, before any hook has fired.
 */
function recentTranscripts(projectsDir, sinceMs, limit = 12) {
  const found = [];
  let folders;
  try {
    folders = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch (_) {
    return found;
  }
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const dir = path.join(projectsDir, folder.name);
    let files;
    try { files = fs.readdirSync(dir); } catch (_) { continue; }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      let stat;
      try { stat = fs.statSync(file); } catch (_) { continue; }
      if (stat.mtimeMs >= sinceMs) {
        found.push({ sessionId: name.slice(0, -'.jsonl'.length), file, mtimeMs: stat.mtimeMs });
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

module.exports = { readTranscript, readLastTurn, recentTranscripts, projectFolder, describeTurn, isInterruption };
