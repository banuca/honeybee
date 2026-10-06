'use strict';

// Codex's limits, asked for directly.
//
// Codex's own app server (`codex app-server`, the same program the Codex IDE
// extension talks to) answers `account/rateLimits/read` with the account's
// current 5-hour and weekly readings. honeybee starts the user's installed
// Codex, asks that one question and lets it go. No prompt is sent, so nothing
// counts against the limits, and Codex does its own signing in: honeybee never
// sees a token.
//
// Between reads the session logs (codex-rollouts.js) still report the limits
// after every turn, so a missing or signed-out Codex costs nothing but
// freshness.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const READ_TIMEOUT_MS = 45 * 1000;
const EVERY_MS = 5 * 60 * 1000;
// Opening the window asks again, but not more often than this.
const MIN_GAP_MS = 60 * 1000;

const TRIPLES = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl'
};

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch (_) { return false; }
}

function listDir(dir) {
  try { return fs.readdirSync(dir); } catch (_) { return []; }
}

// Folders a desktop app may not have on its PATH (a Mac app started from the
// Dock gets almost none), where Codex is commonly installed.
function extraDirs(env, platform) {
  const home = env.HONEYBEE_HOME || os.homedir();
  if (platform === 'win32') {
    return [
      env.APPDATA && path.join(env.APPDATA, 'npm'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'codex'),
      path.join(home, '.local', 'bin')
    ].filter(Boolean);
  }
  return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
    path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'),
    path.join(home, '.volta', 'bin'), path.join(home, '.bun', 'bin')];
}

/**
 * The native Codex program inside an npm install of @openai/codex. The `codex`
 * on the PATH is then a script for Node, which a desktop app may not be able
 * to run (and on Windows a .cmd file, which can't be started without a shell).
 */
function nativeInPackage(packageRoot, platform, arch) {
  const triple = TRIPLES[`${platform}-${arch}`];
  if (!triple) return null;
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  const platformPkg = `codex-${platform}-${arch}`;
  const vendors = [
    path.join(packageRoot, 'node_modules', '@openai', platformPkg, 'vendor'),
    path.join(packageRoot, '..', platformPkg, 'vendor'),
    path.join(packageRoot, 'vendor')
  ];
  for (const vendor of vendors) {
    for (const candidate of [path.join(vendor, triple, 'bin', exe), path.join(vendor, triple, 'codex', exe)]) {
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Find the Codex program to run, without a shell. Returns a path or null.
 */
function findCodex({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  if (env.HONEYBEE_CODEX_BIN) return isFile(env.HONEYBEE_CODEX_BIN) ? env.HONEYBEE_CODEX_BIN : null;
  const pathDirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const dirs = [...new Set([...pathDirs, ...extraDirs(env, platform)])];

  for (const dir of dirs) {
    if (platform === 'win32') {
      // A standalone install puts codex.exe itself on the PATH.
      if (isFile(path.join(dir, 'codex.exe'))) return path.join(dir, 'codex.exe');
      // npm puts codex.cmd next to its node_modules folder.
      if (isFile(path.join(dir, 'codex.cmd'))) {
        const found = nativeInPackage(path.join(dir, 'node_modules', '@openai', 'codex'), platform, arch);
        if (found) return found;
      }
      continue;
    }
    const launcher = path.join(dir, 'codex');
    if (!isFile(launcher)) continue;
    let real = launcher;
    try { real = fs.realpathSync(launcher); } catch (_) { /* keep the link */ }
    // npm links bin/codex.js; anything else (Homebrew, a release download)
    // is the program itself.
    if (!real.endsWith('.js')) return launcher;
    const found = nativeInPackage(path.dirname(path.dirname(real)), platform, arch);
    if (found) return found;
  }

  // The Codex IDE extension carries its own copy.
  const home = env.HONEYBEE_HOME || os.homedir();
  for (const root of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
    const extensions = path.join(home, root, 'extensions');
    const mine = listDir(extensions).filter((n) => n.startsWith('openai.chatgpt-')).sort().reverse();
    for (const name of mine) {
      const bin = path.join(extensions, name, 'bin');
      for (const sub of listDir(bin)) {
        const exe = path.join(bin, sub, platform === 'win32' ? 'codex.exe' : 'codex');
        if (isFile(exe)) return exe;
      }
    }
  }
  return null;
}

function windowOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const used = Number(raw.usedPercent);
  if (!Number.isFinite(used)) return null;
  const minutes = Number(raw.windowDurationMins);
  const resets = Number(raw.resetsAt);
  return {
    usedPercent: Math.max(0, Math.min(100, used)),
    windowMinutes: Number.isFinite(minutes) ? minutes : null,
    resetsAt: Number.isFinite(resets) && resets > 0 ? resets * 1000 : null
  };
}

/**
 * Turn an `account/rateLimits/read` answer into the reading the session logs
 * give (see codex-rollouts.js parseRateLimits). Null when there are no limits
 * to show, e.g. when Codex is signed in with an API key.
 */
function snapshotFromResponse(result, observedAt) {
  if (!result || typeof result !== 'object') return null;
  const byId = result.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object' ? result.rateLimitsByLimitId : null;
  const raw = (byId && byId.codex) || result.rateLimits;
  if (!raw || typeof raw !== 'object') return null;
  const primary = windowOf(raw.primary);
  const secondary = windowOf(raw.secondary);
  if (!primary && !secondary) return null;
  return {
    limitId: typeof raw.limitId === 'string' ? raw.limitId : null,
    planType: typeof raw.planType === 'string' ? raw.planType : null,
    primary,
    secondary,
    reached: typeof raw.rateLimitReachedType === 'string' ? raw.rateLimitReachedType : null,
    observedAt
  };
}

/**
 * Start Codex's app server, ask for the limits, and stop it.
 * Resolves with the raw answer; rejects with a short reason.
 */
function askCodex(bin, { env = process.env, timeoutMs = READ_TIMEOUT_MS, version = '0', args = ['app-server'] } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch (err) {
      reject(new Error(`could not start codex: ${err.message}`));
      return;
    }
    let settled = false;
    let buffer = '';
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Closing its input asks the server to stop; make sure it does.
      try { child.stdin.end(); } catch (_) { /* gone */ }
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); }, 3000).unref?.();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('codex did not answer in time')), timeoutMs);
    const send = (msg) => {
      try { child.stdin.write(`${JSON.stringify(msg)}\n`); } catch (_) { /* reported by exit */ }
    };

    child.on('error', (err) => finish(new Error(`codex: ${err.message}`)));
    child.on('exit', (code) => finish(new Error(`codex stopped (${code}) before answering`)));
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) return finish(new Error('codex answer too large'));
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.id === 1) {
          if (msg.error) return finish(new Error(`codex: ${msg.error.message || 'initialize failed'}`));
          send({ jsonrpc: '2.0', method: 'initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
        } else if (msg.id === 2) {
          if (msg.error) return finish(new Error(`codex: ${msg.error.message || 'no limits'}`));
          return finish(null, msg.result);
        }
      }
    });

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'honeybee', version }, capabilities: null } });
  });
}

class CodexLimits {
  /**
   * @param {object} opts
   * @param {(snapshot: object) => void} opts.onUsage
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ onUsage, log = () => {}, env = process.env, version = '0', now = Date.now, find = findCodex, ask = askCodex }) {
    this.onUsage = onUsage;
    this.log = log;
    this.env = env;
    this.version = version;
    this.now = now;
    this.find = find;
    this.ask = ask;
    this.running = null;
    this.lastAttemptAt = 0;
    this.lastError = undefined;
    this.timer = null;
  }

  start({ everyMs = EVERY_MS } = {}) {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), everyMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Ask now, unless a read is under way or one was made a moment ago. */
  soon() {
    if (this.now() - this.lastAttemptAt < MIN_GAP_MS) return null;
    return this.refresh();
  }

  refresh() {
    if (this.running) return this.running;
    this.lastAttemptAt = this.now();
    const bin = this.find({ env: this.env });
    if (!bin) {
      this.note('codex not found');
      return null;
    }
    this.running = this.ask(bin, { env: this.env, version: this.version })
      .then((result) => {
        const snapshot = snapshotFromResponse(result, this.now());
        if (!snapshot) {
          this.note('codex has no plan limits to report');
          return null;
        }
        if (this.lastError !== null) this.log('codex limits: reading');
        this.lastError = null;
        this.onUsage(snapshot);
        return snapshot;
      })
      .catch((err) => {
        this.note(err.message);
        return null;
      })
      .finally(() => { this.running = null; });
    return this.running;
  }

  // Say why a read failed once, not every five minutes.
  note(reason) {
    if (reason !== this.lastError) this.log(`codex limits: ${reason}`);
    this.lastError = reason;
  }
}

module.exports = { CodexLimits, findCodex, nativeInPackage, snapshotFromResponse, askCodex };
