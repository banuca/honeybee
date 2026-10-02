'use strict';

// honeybee's main process: one small controller that owns the state, the
// local server, the file watchers, the windows and the tray.

const { app, BrowserWindow, Tray, Menu, Notification, dialog, ipcMain, nativeImage, nativeTheme, powerMonitor, screen, shell, session, net, systemPreferences } = require('electron');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('./paths');
const { JsonStore } = require('./store');
const { Agents } = require('./agents');
const { Usage, parseStatusLine, statusLineText } = require('./usage');
const { CodexRollouts } = require('./codex-rollouts');
const transcripts = require('./claude-transcript');
const integrations = require('./integrations');
const { createServer } = require('./server');
const { fitBoundsToDisplays } = require('./window-bounds');
const { parseReleaseResponse, releasesUrlFor } = require('./version-compare');
const autostart = require('./autostart');

const APP_ID = 'com.banuca.honeybee';
const OWNER = 'banuca';
const REPO = 'honeybee';
const DEFAULT_PORT = 47621;
const RENDERER = path.join(__dirname, '..', 'renderer');
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const SEED_WINDOW_MS = 20 * 60 * 1000;
const BUBBLE_SIZE = 64;
const MIN_WIDTH = 300;
const MIN_HEIGHT = 220;

const SETTING_TYPES = {
  theme: (v) => ['system', 'dark', 'light'].includes(v),
  alwaysOnTop: (v) => typeof v === 'boolean',
  bubbleOnClose: (v) => typeof v === 'boolean',
  notifyNeedsYou: (v) => typeof v === 'boolean',
  notifyDone: (v) => typeof v === 'boolean',
  notifySound: (v) => typeof v === 'boolean',
  launchAtLogin: (v) => typeof v === 'boolean',
  view: (v) => ['agents', 'usage'].includes(v)
};

const EXTERNAL_ALLOWED = [
  /^https:\/\/github\.com\/banuca\/honeybee(\/[\w\-./#?=&%]*)?$/,
  /^https:\/\/code\.claude\.com\/docs\/[\w\-./#?=&%]*$/,
  /^https:\/\/learn\.chatgpt\.com\/docs\/[\w\-./#?=&%]*$/
];

function start({ argv = process.argv, env = process.env, test = null } = {}) {
  if (env.HONEYBEE_USER_DATA) app.setPath('userData', env.HONEYBEE_USER_DATA);
  app.setName('honeybee');
  // Windows names a notification after the Start Menu shortcut carrying this
  // ID, and Electron creates one itself the first time it notifies. A run from
  // source would leave an "Electron" shortcut that takes over the installed
  // app's notifications, so only the packaged app uses the real ID.
  if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? APP_ID : `${APP_ID}.dev`);

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return null;
  }

  const selfTestArg = argv.find((a) => a.startsWith('--self-test='));
  const selfTestFile = selfTestArg ? selfTestArg.slice('--self-test='.length) : null;
  const startHidden = autostart.startedAtLogin(app, argv);
  // From package.json rather than app.getVersion(), which reports Electron's
  // own version when the app is started through a test script.
  const version = require('../../package.json').version;

  const ctl = {
    version,
    settings: null,
    state: null,
    agents: null,
    usage: null,
    server: null,
    serverError: null,
    rollouts: null,
    main: null,
    bubble: null,
    bubbleReady: null,
    fold: null,
    foldLoaded: false,
    foldEvents: null,
    foldTimer: null,
    foldPlaced: null,
    folding: null,
    lastFold: null,
    tray: null,
    quitting: false,
    update: null,
    seen: { claudeHookAt: null, claudeStatusLineAt: null, codexHookAt: null, codexLogAt: null },
    log: (msg) => { if (env.HONEYBEE_DEBUG) console.log(`[honeybee] ${msg}`); },
    ready: null
  };

  let readyResolve;
  ctl.ready = new Promise((resolve) => { readyResolve = resolve; });

  app.on('second-instance', () => showMain());
  app.on('window-all-closed', (e) => e.preventDefault?.());
  app.on('before-quit', () => { ctl.quitting = true; });
  app.on('activate', () => showMain());

  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
  });

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
    setupMenu(ctl);
    setupState(ctl, env);
    await startServer(ctl, env);
    repairIntegrations(ctl, env);
    startWatchers(ctl, env);
    setupIpc(ctl, env);
    createTray(ctl);
    if (startHidden && !selfTestFile) showBubble(ctl);
    else createMain(ctl, { show: true });
    if (!env.HONEYBEE_OFFLINE) {
      setTimeout(() => checkForUpdate(ctl), 15000).unref?.();
      setInterval(() => checkForUpdate(ctl), 12 * 3600 * 1000).unref?.();
    }
    // Shutting the computer down must not be held up by "X only hides".
    powerMonitor.on('shutdown', () => { ctl.quitting = true; app.quit(); });
    readyResolve(ctl);
    if (selfTestFile) runSelfTest(ctl, selfTestFile);
  }).catch((err) => {
    // Never linger as an invisible process holding the single-instance lock.
    const detail = String((err && err.stack) || err);
    if (selfTestFile) {
      try { fs.writeFileSync(selfTestFile, JSON.stringify({ ok: false, steps: { startup: detail } }, null, 2)); } catch (_) { /* nowhere to report */ }
    } else {
      dialog.showErrorBox('honeybee could not start', `${detail}\n\nPlease report this at https://github.com/${OWNER}/${REPO}/issues`);
    }
    app.exit(1);
  });

  app.on('will-quit', () => {
    ctl.rollouts?.stop();
    saveState(ctl, true);
    ctl.settings?.saveNow();
  });

  // ---- windows ------------------------------------------------------------

  function showMain() {
    if (!ctl.settings) return;
    cancelFold(ctl);
    if (!ctl.main || ctl.main.isDestroyed()) createMain(ctl, { show: true });
    else {
      if (ctl.main.isMinimized()) ctl.main.restore();
      ctl.main.setOpacity(1);
      ctl.main.show();
      ctl.main.focus();
      prepareFold(ctl);
    }
    hideBubble(ctl);
  }
  ctl.showMain = showMain;

  return ctl;
}

// ---- menu -------------------------------------------------------------------

// No default menu (its Reload and DevTools shortcuts have no place in a
// widget). macOS keeps the minimum it expects: About, Quit, and Edit for
// copy and paste.
function setupMenu(ctl) {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'honeybee', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Window', submenu: [{ label: 'Close', accelerator: 'Cmd+W', click: () => collapse(ctl) }, { role: 'minimize' }] }
  ]));
}

// ---- state ------------------------------------------------------------------

const SETTINGS_DEFAULTS = {
  token: null,
  port: DEFAULT_PORT,
  theme: 'system',
  alwaysOnTop: false,
  bubbleOnClose: true,
  notifyNeedsYou: true,
  notifyDone: true,
  notifySound: true,
  launchAtLogin: false,
  view: 'agents',
  windowBounds: null,
  bubblePosition: null,
  claude: { connected: false, previousStatusLine: null, connectedAt: null },
  codex: { connected: false, connectedAt: null }
};

// A settings file edited by hand (or by an older version) may hold values the
// app can't use. Each one that fails its check goes back to the default.
function sanitizeSettings(store) {
  const d = store.data;
  let fixed = false;
  for (const [key, valid] of Object.entries(SETTING_TYPES)) {
    if (!valid(d[key])) { d[key] = SETTINGS_DEFAULTS[key]; fixed = true; }
  }
  if (!Number.isInteger(d.port) || d.port < 1024 || d.port > 65535) { d.port = DEFAULT_PORT; fixed = true; }
  if (typeof d.token !== 'string' || !/^[0-9a-f]{32,}$/.test(d.token)) {
    d.token = crypto.randomBytes(24).toString('hex');
    fixed = true;
  }
  for (const agent of ['claude', 'codex']) {
    if (!d[agent] || typeof d[agent] !== 'object' || Array.isArray(d[agent])) { d[agent] = { ...SETTINGS_DEFAULTS[agent] }; fixed = true; }
  }
  for (const key of ['windowBounds', 'bubblePosition']) {
    const b = d[key];
    if (b !== null && !(b && Number.isFinite(b.x) && Number.isFinite(b.y))) { d[key] = null; fixed = true; }
  }
  if (fixed) store.saveNow();
}

function setupState(ctl, env) {
  const userData = app.getPath('userData');
  ctl.settings = new JsonStore(path.join(userData, 'settings.json'), SETTINGS_DEFAULTS);
  sanitizeSettings(ctl.settings);
  ctl.state = new JsonStore(path.join(userData, 'state.json'), { sessions: [], usage: null, seen: null });

  ctl.agents = new Agents({ onChange: () => changed(ctl), onAlert: (a) => notify(ctl, a) });
  ctl.usage = new Usage({ onChange: () => changed(ctl) });
  ctl.agents.restore(ctl.state.get('sessions'));
  ctl.usage.restore(ctl.state.get('usage'));
  const seen = ctl.state.get('seen');
  if (seen && typeof seen === 'object') Object.assign(ctl.seen, seen);
  nativeTheme.themeSource = ctl.settings.get('theme');
}

function saveState(ctl, now = false) {
  if (!ctl.state) return;
  ctl.state.data.sessions = ctl.agents.serialize();
  ctl.state.data.usage = ctl.usage.serialize();
  ctl.state.data.seen = ctl.seen;
  if (now) ctl.state.saveNow();
  else ctl.state.saveSoon(2000);
}

let pushTimer = null;
function changed(ctl) {
  saveState(ctl);
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => push(ctl), 60);
}

function push(ctl) {
  const snapshot = snapshotOf(ctl);
  for (const win of [ctl.main, ctl.bubble]) {
    if (win && !win.isDestroyed()) win.webContents.send('state', snapshot);
  }
  updateTray(ctl, snapshot);
}

// The region the user chose for dates and times (12- or 24-hour clock), which
// can differ from the language Electron's interface runs in.
function systemLocale() {
  try { return app.getSystemLocale() || app.getLocale(); } catch (_) { return undefined; }
}

function publicSession(s) {
  return {
    key: s.key, agent: s.agent, status: s.status, reason: s.reason, statusSince: s.statusSince,
    updatedAt: s.updatedAt, title: s.title, project: s.project, lastMessage: s.lastMessage,
    contextPercent: s.contextPercent, model: s.model
  };
}

function snapshotOf(ctl) {
  const st = ctl.settings.data;
  const port = ctl.server ? ctl.server.port : st.port;
  return {
    version: ctl.version,
    platform: process.platform,
    locale: systemLocale(),
    now: Date.now(),
    agents: ctl.agents.list().map(publicSession),
    counts: ctl.agents.counts(),
    usage: ctl.usage.view(),
    integrations: integrationStatus(ctl),
    server: { port, listening: Boolean(ctl.server && ctl.server.port), error: ctl.serverError },
    settings: {
      theme: st.theme, alwaysOnTop: st.alwaysOnTop, bubbleOnClose: st.bubbleOnClose,
      notifyNeedsYou: st.notifyNeedsYou, notifyDone: st.notifyDone, notifySound: st.notifySound,
      launchAtLogin: st.launchAtLogin, view: st.view
    },
    update: ctl.update,
    seen: ctl.seen
  };
}

// Reading the agents' settings files on every update would be wasteful, so a
// check is only redone when a file (or the port) actually changed.
const checkCache = new Map();
function cachedCheck(name, files, compute) {
  const stamp = files.map((f) => {
    try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch (_) { return 'none'; }
  }).join('|');
  const hit = checkCache.get(name);
  if (hit && hit.stamp === stamp) return hit.value;
  const value = compute();
  checkCache.set(name, { stamp, value });
  return value;
}

function integrationStatus(ctl) {
  const st = ctl.settings.data;
  const port = ctl.server && ctl.server.port ? ctl.server.port : st.port;
  const token = st.token;
  const claudeFile = paths.claudeSettingsPath();
  const codexFile = paths.codexHooksPath();
  const toml = path.join(paths.codexDir(), 'config.toml');
  const claude = cachedCheck(`claude:${port}`, [claudeFile], () => integrations.checkClaude({ file: claudeFile, port, token }));
  const codex = cachedCheck(`codex:${port}`, [codexFile, toml], () => integrations.checkCodex({ file: codexFile, port, token, configToml: toml }));
  return {
    claude: {
      connected: Boolean(st.claude && st.claude.connected) && claude.hooks,
      check: claude,
      file: claudeFile,
      present: fs.existsSync(paths.claudeDir()),
      hookSeenAt: ctl.seen.claudeHookAt,
      statusLineSeenAt: ctl.seen.claudeStatusLineAt
    },
    codex: {
      connected: Boolean(st.codex && st.codex.connected) && codex.hooks,
      check: codex,
      file: codexFile,
      present: fs.existsSync(paths.codexDir()),
      hookSeenAt: ctl.seen.codexHookAt,
      logSeenAt: ctl.seen.codexLogAt
    }
  };
}

// ---- server -----------------------------------------------------------------

async function startServer(ctl, env) {
  const token = ctl.settings.get('token');
  const handlers = {
    claudeHook: (p) => {
      ctl.seen.claudeHookAt = Date.now();
      ctl.agents.claudeEvent(p);
      if (typeof p.session_id === 'string') refreshClaudeDetails(ctl, `claude:${p.session_id}`);
    },
    codexHook: (p) => {
      ctl.seen.codexHookAt = Date.now();
      ctl.agents.codexEvent(p);
    },
    claudeStatusLine: (p) => {
      ctl.seen.claudeStatusLineAt = Date.now();
      const { usage, context } = parseStatusLine(p, Date.now());
      if (usage) ctl.usage.setClaude(usage);
      if (context) ctl.agents.claudeContext(context.sessionId, context);
      changed(ctl);
      return statusLineText(p);
    }
  };
  const port = env.HONEYBEE_PORT !== undefined ? Number(env.HONEYBEE_PORT) : ctl.settings.get('port');
  ctl.server = createServer({ token, handlers, log: ctl.log });
  try {
    await ctl.server.listen(port);
    ctl.serverError = null;
    ctl.log(`listening on 127.0.0.1:${ctl.server.port}`);
  } catch (err) {
    ctl.serverError = err.code === 'EADDRINUSE'
      ? `Port ${port} is in use by another program.`
      : `Could not listen on port ${port}: ${err.message}`;
    ctl.server = null;
  }
}

// Move to the next free port (only when the usual one is taken), and point
// the hooks that are already connected at it.
async function moveToFreePort(ctl, env) {
  if (ctl.movingPort) return { ok: false, message: 'Already moving to another port.' };
  ctl.movingPort = true;
  try {
    if (ctl.server) {
      await ctl.server.close();
      ctl.server = null;
    }
    const base = ctl.settings.get('port');
    const token = ctl.settings.get('token');
    for (let port = base + 1; port < base + 40; port += 1) {
      const candidate = createServer({ token, handlers: {}, log: ctl.log });
      try {
        await candidate.listen(port);
        await candidate.close();
      } catch (_) {
        continue; // taken; try the next
      }
      ctl.settings.set('port', port);
      ctl.settings.saveNow();
      await startServer(ctl, { ...env, HONEYBEE_PORT: undefined });
      if (!ctl.server) continue;
      repairIntegrations(ctl, env, { codexToo: true });
      changed(ctl);
      return { ok: true, port };
    }
    return { ok: false, message: 'No free port nearby.' };
  } finally {
    ctl.movingPort = false;
  }
}

// Keep connected hooks pointing at the port and token in use. Claude Code's
// are rewritten quietly (they are honeybee's own entries). Codex re-asks the
// user to trust a changed hook, so those are only rewritten on request.
function repairIntegrations(ctl, env, { codexToo = false } = {}) {
  if (!ctl.server) return;
  const st = ctl.settings.data;
  const port = ctl.server.port;
  const token = st.token;
  if (st.claude && st.claude.connected) {
    const file = paths.claudeSettingsPath();
    const check = integrations.checkClaude({ file, port, token });
    if (check.error) return;
    if (!check.hooks && !check.partial) {
      // Removed by hand: respect that.
      ctl.settings.set('claude', { ...st.claude, connected: false });
    } else if (check.hooks && (!check.current || (check.statusLine === 'ours' && !check.statusLineCurrent))) {
      // All there but pointing at an old port or token: bring them up to date.
      try { integrations.installClaude({ file, port, token }); } catch (err) { ctl.log(`claude repair: ${err.message}`); }
    }
    // Some removed by hand (partial): left alone; settings offers to reconnect.
  }
  if (codexToo && st.codex && st.codex.connected) {
    try { integrations.installCodex({ file: paths.codexHooksPath(), port, token }); } catch (err) { ctl.log(`codex repair: ${err.message}`); }
  }
}

// ---- watchers ---------------------------------------------------------------

function startWatchers(ctl, env) {
  ctl.rollouts = new CodexRollouts({
    sessionsDir: paths.codexSessionsDir(),
    onSession: (info) => {
      ctl.seen.codexLogAt = Date.now();
      ctl.agents.codexLog(info);
    },
    onUsage: (snapshot) => ctl.usage.setCodex(snapshot)
  });
  ctl.rollouts.start();

  // Claude sessions active in the last few minutes, before any hook arrives.
  for (const t of transcripts.recentTranscripts(paths.claudeProjectsDir(), Date.now() - SEED_WINDOW_MS)) {
    if (ctl.agents.get('claude', t.sessionId)) continue;
    ctl.agents.claudeSeed({ sessionId: t.sessionId, transcriptPath: t.file, mtimeMs: t.mtimeMs, details: transcripts.readTranscript(t.file) });
  }

  // Esc and rejected approvals fire no hook; the transcript shows them.
  const stamps = new Map();
  setInterval(() => {
    for (const s of ctl.agents.sessions.values()) {
      if (s.agent !== 'claude' || !s.transcriptPath) continue;
      if (s.status !== 'working' && s.status !== 'needs-you') continue;
      let stat;
      try { stat = fs.statSync(s.transcriptPath); } catch (_) { continue; }
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      if (stamps.get(s.key) === stamp) continue;
      stamps.set(s.key, stamp);
      ctl.agents.claudeTurn(s.key, transcripts.readLastTurn(s.transcriptPath));
    }
  }, 1500).unref?.();

  setInterval(() => ctl.agents.expire(), 60 * 1000).unref?.();
  // Relative times and resets move on even when nothing happens.
  setInterval(() => push(ctl), 30 * 1000).unref?.();
}

const detailTimers = new Map();
function refreshClaudeDetails(ctl, key) {
  if (detailTimers.has(key)) return;
  detailTimers.set(key, setTimeout(() => {
    detailTimers.delete(key);
    const s = ctl.agents.sessions.get(key);
    if (s && s.transcriptPath) ctl.agents.claudeDetails(key, transcripts.readTranscript(s.transcriptPath));
  }, 1500));
}

// ---- notifications ----------------------------------------------------------

const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex' };

// "Finished" waits a moment before it is announced: another Stop hook can send
// the agent straight back to work ("keep going until the tests pass"), and
// then the news was premature.
const DONE_SETTLE_MS = 2500;
const pendingDone = new Map();
// Notifications are kept referenced while on screen; one that is garbage
// collected stops responding to clicks.
const liveNotifications = new Set();

function notify(ctl, alert) {
  if (alert.kind !== 'done') {
    deliver(ctl, alert);
    return;
  }
  clearTimeout(pendingDone.get(alert.key));
  pendingDone.set(alert.key, setTimeout(() => {
    pendingDone.delete(alert.key);
    const s = ctl.agents.sessions.get(alert.key);
    if (s && s.status === 'done') deliver(ctl, { ...alert, title: s.title, project: s.project, lastMessage: s.lastMessage });
  }, DONE_SETTLE_MS));
}

function deliver(ctl, alert) {
  const st = ctl.settings.data;
  flashBubble(ctl, alert.kind);
  if (alert.kind === 'needs-you' && !st.notifyNeedsYou) return;
  if (alert.kind === 'failed' && !st.notifyNeedsYou) return;
  if (alert.kind === 'done' && !st.notifyDone) return;
  if (ctl.main && !ctl.main.isDestroyed() && ctl.main.isVisible() && ctl.main.isFocused()) return;
  if (!Notification.isSupported()) return;
  const agent = AGENT_NAMES[alert.agent] || alert.agent;
  const titles = { 'needs-you': `${agent} needs you`, done: `${agent} finished`, failed: `${agent} stopped` };
  const what = alert.title || alert.project || 'a session';
  const detail = alert.kind === 'done' ? alert.lastMessage : alert.reason;
  try {
    const n = new Notification({
      title: titles[alert.kind],
      body: detail ? `${what}: ${detail}` : what,
      silent: !st.notifySound
    });
    liveNotifications.add(n);
    const release = () => liveNotifications.delete(n);
    n.on('click', () => { release(); ctl.showMain(); });
    n.on('close', release);
    n.on('failed', release);
    setTimeout(release, 10 * 60 * 1000).unref?.();
    n.show();
    ctl.notified = (ctl.notified || 0) + 1;
  } catch (err) {
    ctl.log(`notification: ${err.message}`);
  }
}

// ---- main window ------------------------------------------------------------

function themeBackground(ctl) {
  return nativeTheme.shouldUseDarkColors ? '#131111' : '#f3eeeb';
}

function createMain(ctl, { show }) {
  const saved = ctl.settings.get('windowBounds');
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay().workArea;
  const fallback = { width: 380, height: 560, x: primary.x + primary.width - 380 - 24, y: primary.y + 48 };
  const fitted = fitBoundsToDisplays(saved || fallback, displays, { minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT });
  const bounds = fitted.bounds || fallback;

  const win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    show: false,
    title: 'honeybee',
    backgroundColor: themeBackground(ctl),
    alwaysOnTop: ctl.settings.get('alwaysOnTop'),
    fullscreenable: false,
    maximizable: false,
    icon: process.platform === 'linux' ? path.join(ASSETS, 'icon.png') : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'main.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  ctl.main = win;
  win.setMenu?.(null);
  win.loadFile(path.join(RENDERER, 'index.html'));
  win.once('ready-to-show', () => {
    if (show) {
      win.show();
      hideBubble(ctl);
      prepareFold(ctl);
    }
  });

  let boundsTimer = null;
  const rememberBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!win.isDestroyed() && !win.isMinimized()) ctl.settings.set('windowBounds', win.getBounds());
      fitFoldLayer(ctl);
    }, 400);
  };
  win.on('move', rememberBounds);
  win.on('resize', rememberBounds);

  // X keeps honeybee running: the window folds into the bubble (or the tray).
  win.on('close', (event) => {
    if (ctl.quitting) return;
    event.preventDefault();
    collapse(ctl);
  });
  win.on('closed', () => { if (ctl.main === win) ctl.main = null; });
  // Windows is logging off or shutting down: let the window really close.
  win.on('session-end', () => { ctl.quitting = true; });
  win.webContents.on('did-finish-load', () => push(ctl));
  return win;
}

function collapse(ctl) {
  if (ctl.folding) return;
  const main = ctl.main;
  const onScreen = main && !main.isDestroyed() && main.isVisible() && !main.isMinimized();
  if (onScreen && ctl.foldLoaded && foldPossible(ctl)) {
    foldIntoBubble(ctl);
    return;
  }
  releaseFold(ctl);
  if (main && !main.isDestroyed()) main.hide();
  if (ctl.settings.get('bubbleOnClose')) showBubble(ctl);
}

// ---- folding into the bubble ------------------------------------------------

// X turns the window into a bee that flies home to the bubble. A live window
// can't be animated smoothly, so a snapshot of it is, on a see-through layer
// above everything. Opening a window takes a moment (most of a second on a busy machine), so
// the layer is made while the window is open, and closed again once the
// bubble has taken over. It waits on screen, empty, already covering the
// way from the window to the bubble: Windows fades a window in as it is
// shown, and takes a moment to redraw one it has resized, and either would
// leave a gap between the window going and the snapshot appearing.
//
// Windows and macOS only for now: on Linux (Wayland) an app can't place its
// windows, and without a compositor the layer would show as a black box.
const FOLD_MS = 920;
const FOLD_PAD = 24;
const FOLD_STAGES = ['shown', 'late', 'landed'];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function foldPossible(ctl) {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return false;
  if (!ctl.settings.get('bubbleOnClose')) return false;
  try { return !systemPreferences.getAnimationSettings().prefersReducedMotion; } catch (_) { return true; }
}

function prepareFold(ctl) {
  clearTimeout(ctl.foldTimer);
  if (!foldPossible(ctl) || (ctl.fold && !ctl.fold.isDestroyed())) return;
  // After the window's own first paint, so the two don't compete.
  ctl.foldTimer = setTimeout(() => {
    const main = ctl.main;
    if (!main || main.isDestroyed() || !main.isVisible() || (ctl.fold && !ctl.fold.isDestroyed())) return;
    createFoldLayer(ctl);
  }, 1000);
}

// Where the fold would play now: from the window to the bubble, or, with the
// bubble on another screen and out of reach, into the window's own centre.
function foldPlan(ctl) {
  const from = ctl.main.getBounds();
  const display = screen.getDisplayMatching(from);
  const bubbleAt = bubbleBounds(ctl);
  const together = screen.getDisplayMatching(bubbleAt).id === display.id;
  const to = together ? bubbleAt : {
    x: Math.round(from.x + (from.width - BUBBLE_SIZE) / 2),
    y: Math.round(from.y + (from.height - BUBBLE_SIZE) / 2),
    width: BUBBLE_SIZE,
    height: BUBBLE_SIZE
  };
  return { from, to, display, together, region: foldRegion(from, to, display.bounds) };
}

function sameBounds(a, b) {
  return Boolean(a && b) && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

// Places the layer over `region`, remembering what was asked for: on a
// scaled screen Windows rounds the bounds it reports back, so comparing
// with those would find the layer out of place every time.
function placeFoldLayer(ctl, region) {
  if (sameBounds(ctl.foldPlaced, region)) return false;
  ctl.fold.setBounds(region);
  ctl.foldPlaced = region;
  return true;
}

// The window moved or was resized: the layer follows, while it is empty.
function fitFoldLayer(ctl) {
  const layer = ctl.fold;
  if (!layer || layer.isDestroyed() || !ctl.foldLoaded || ctl.folding) return;
  if (!ctl.main || ctl.main.isDestroyed()) return;
  placeFoldLayer(ctl, foldPlan(ctl).region);
}

function createFoldLayer(ctl) {
  const win = new BrowserWindow({
    width: BUBBLE_SIZE,
    height: BUBBLE_SIZE,
    show: false,
    // A tool window: never listed in Alt+Tab or the taskbar.
    type: process.platform === 'win32' ? 'toolbar' : undefined,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    title: 'honeybee',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'fold.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  const events = new EventEmitter();
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.webContents.ipc.on('fold', (_event, what) => {
    if (FOLD_STAGES.includes(what)) events.emit(what);
  });
  win.webContents.once('did-finish-load', () => {
    if (ctl.fold !== win || !ctl.main || ctl.main.isDestroyed()) return;
    ctl.foldPlaced = null;
    placeFoldLayer(ctl, foldPlan(ctl).region);
    win.showInactive();
    ctl.foldLoaded = true;
  });
  win.on('closed', () => {
    if (ctl.fold === win) {
      ctl.fold = null;
      ctl.foldLoaded = false;
    }
  });
  ctl.fold = win;
  ctl.foldEvents = events;
  ctl.foldLoaded = false;
  win.loadFile(path.join(RENDERER, 'fold.html'));
}

function releaseFold(ctl) {
  clearTimeout(ctl.foldTimer);
  const layer = ctl.fold;
  ctl.fold = null;
  ctl.foldLoaded = false;
  if (layer && !layer.isDestroyed()) layer.destroy();
}

function cancelFold(ctl) {
  if (!ctl.folding) return;
  ctl.folding.cancelled = true;
  ctl.folding = null;
  releaseFold(ctl);
}

// True when the layer reports `name`, false if it hasn't within `ms`.
function heard(events, name, ms) {
  return new Promise((resolve) => {
    const done = (ok) => {
      clearTimeout(timer);
      events.removeListener(name, onEvent);
      resolve(ok);
    };
    const onEvent = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    events.once(name, onEvent);
  });
}

// Where the fold plays: the window, the bubble and a margin, on one screen.
function foldRegion(from, to, area) {
  const x = Math.max(area.x, Math.min(from.x, to.x) - FOLD_PAD);
  const y = Math.max(area.y, Math.min(from.y, to.y) - FOLD_PAD);
  const right = Math.min(area.x + area.width, Math.max(from.x + from.width, to.x + to.width) + FOLD_PAD);
  const bottom = Math.min(area.y + area.height, Math.max(from.y + from.height, to.y + to.height) + FOLD_PAD);
  return { x, y, width: right - x, height: bottom - y };
}

// A rectangle's place inside the region, in whole device pixels, so the
// snapshot covers the window exactly and the stand-in lands on the bubble.
function placeWithin(rect, region, scale) {
  let x = rect.x - region.x;
  let y = rect.y - region.y;
  if (process.platform === 'win32') {
    const a = screen.dipToScreenPoint({ x: rect.x, y: rect.y });
    const b = screen.dipToScreenPoint({ x: region.x, y: region.y });
    x = (a.x - b.x) / scale;
    y = (a.y - b.y) / scale;
  }
  return { x, y, width: rect.width, height: rect.height };
}

// The snapshot as an uncompressed BMP, at the screen's full resolution.
// Building one is a copy; a PNG takes most of a third of a second to
// compress for a large window, and the window can't fold until it's done.
function snapshotBmp(image) {
  const scale = Math.max(1, ...image.getScaleFactors());
  const { width, height } = image.getSize(scale);
  const pixels = image.toBitmap({ scaleFactor: scale }); // BGRA, top row first
  if (pixels.length !== width * height * 4) return null;
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(-height, 22); // negative: rows run top to bottom
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(32, 28);
  header.writeUInt32LE(pixels.length, 34);
  return Buffer.concat([header, pixels]);
}

// The rounded corners the system gives the window, copied by the snapshot.
function windowCornerRadius() {
  if (process.platform === 'darwin') return 10;
  if (process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22000) return 8;
  return 0;
}

// The window is swapped for its snapshot before anything moves, and the
// stand-in hexagon for the real bubble after it lands, so nothing flickers.
async function foldIntoBubble(ctl) {
  const main = ctl.main;
  const layer = ctl.fold;
  const events = ctl.foldEvents;
  const run = { cancelled: false };
  const started = Date.now();
  const record = { played: false, presented: null, startedAfterMs: null, handedOverAfterMs: null, error: null };
  ctl.folding = run;
  ctl.lastFold = record;
  const going = () => !run.cancelled && !ctl.quitting;
  const live = () => going() && !layer.isDestroyed() && !main.isDestroyed();
  try {
    const { from, to, display, together, region } = foldPlan(ctl);
    showBubble(ctl, { hidden: true });
    const image = await main.webContents.capturePage();
    record.capturedAfterMs = Date.now() - started;
    if (!live() || image.isEmpty()) throw new Error('no snapshot of the window');
    // Moved a moment ago: the layer catches up, and gets time to redraw.
    if (placeFoldLayer(ctl, region)) {
      await wait(250);
      if (!live()) throw new Error('stopped');
    }
    layer.moveTop();
    let late = false;
    const noteLate = () => { late = true; };
    events.once('late', noteLate);
    const encoded = snapshotBmp(image) || image.toDataURL();
    record.encodedAfterMs = Date.now() - started;
    layer.webContents.send('fold:play', {
      image: encoded,
      from: placeWithin(from, region, display.scaleFactor),
      to: placeWithin(to, region, display.scaleFactor),
      counts: together ? ctl.agents.counts() : null,
      radius: windowCornerRadius(),
      ms: FOLD_MS
    });
    // The layer says when the snapshot is on screen, over the window.
    const shown = await heard(events, 'shown', 1500);
    record.shownAfterMs = Date.now() - started;
    events.removeListener('late', noteLate);
    if (!shown || !live()) throw new Error('the snapshot did not appear');
    record.presented = !late;
    // Windows would fade the window out where it stands, behind the moving
    // snapshot. Made transparent first, it simply goes.
    main.setOpacity(0);
    main.hide();
    layer.webContents.send('fold:go');
    record.played = true;
    record.startedAfterMs = Date.now() - started;
    await heard(events, 'landed', FOLD_MS + 600);
    if (!going()) return;
    // The stand-in covers the wait for the real bubble to load.
    await Promise.race([ctl.bubbleReady, wait(5000)]);
    if (!going()) return;
    const bubble = ctl.bubble;
    if (bubble && !bubble.isDestroyed()) {
      bubble.moveTop();
      bubble.showInactive();
    } else {
      showBubble(ctl);
    }
    await wait(250);
    record.handedOverAfterMs = Date.now() - started;
  } catch (err) {
    record.error = err.message;
    ctl.log(`fold: ${err.message}`);
    // Whatever went wrong, end where X always ends.
    if (!run.cancelled && !ctl.quitting) {
      if (!main.isDestroyed()) main.hide();
      showBubble(ctl);
    }
  } finally {
    if (!run.cancelled) {
      ctl.folding = null;
      releaseFold(ctl);
    }
    ctl.log(`fold: ${JSON.stringify(record)}`);
  }
}

// ---- bubble -----------------------------------------------------------------

// Until the bubble is dragged somewhere, it sits in the bottom corner of the
// screen the window is on, so the bee never has to cross between screens.
function defaultBubblePosition(ctl) {
  const main = ctl.main && !ctl.main.isDestroyed() ? ctl.main.getBounds() : ctl.settings.get('windowBounds');
  const display = main && Number.isFinite(main.width) ? screen.getDisplayMatching(main) : screen.getPrimaryDisplay();
  const area = display.workArea;
  return { x: area.x + area.width - BUBBLE_SIZE - 24, y: area.y + area.height - BUBBLE_SIZE - 24 };
}

function bubbleBounds(ctl) {
  const saved = ctl.settings.get('bubblePosition') || defaultBubblePosition(ctl);
  const fitted = fitBoundsToDisplays({ ...saved, width: BUBBLE_SIZE, height: BUBBLE_SIZE }, screen.getAllDisplays());
  return fitted.bounds || { ...defaultBubblePosition(ctl), width: BUBBLE_SIZE, height: BUBBLE_SIZE };
}

// Shows the bubble as soon as it has loaded. `hidden` only loads it, for the
// fold to reveal when it lands.
function showBubble(ctl, { hidden = false } = {}) {
  let win = ctl.bubble;
  if (!win || win.isDestroyed()) win = createBubble(ctl);
  if (!hidden) {
    ctl.bubbleReady.then(() => {
      if (ctl.bubble === win && !win.isDestroyed()) win.showInactive();
    });
  }
  return win;
}

function createBubble(ctl) {
  const pos = bubbleBounds(ctl);
  const win = new BrowserWindow({
    x: pos.x, y: pos.y, width: BUBBLE_SIZE, height: BUBBLE_SIZE,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: 'honeybee',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'bubble.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  ctl.bubble = win;
  win.setAlwaysOnTop(true, 'floating');
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Ready at its first paint. Without a GPU (some Linux setups) that can be
  // slow to report, and the bubble must appear regardless, or there is no way
  // back to the window.
  ctl.bubbleReady = new Promise((resolve) => {
    win.once('ready-to-show', resolve);
    win.webContents.once('did-finish-load', () => setTimeout(resolve, 1200));
  });
  win.loadFile(path.join(RENDERER, 'bubble.html'));
  win.webContents.on('did-finish-load', () => push(ctl));
  win.on('closed', () => { if (ctl.bubble === win) ctl.bubble = null; });
  return win;
}

function hideBubble(ctl) {
  if (ctl.bubble && !ctl.bubble.isDestroyed()) {
    const b = ctl.bubble;
    ctl.bubble = null;
    b.destroy();
  }
}

function flashBubble(ctl, kind) {
  if (ctl.bubble && !ctl.bubble.isDestroyed()) ctl.bubble.webContents.send('flash', kind);
}

// ---- tray -------------------------------------------------------------------

function trayImage(state) {
  if (process.platform === 'darwin' && state === 'idle') {
    const img = nativeImage.createFromPath(path.join(ASSETS, 'tray', 'trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(path.join(ASSETS, 'tray', `tray-${state}.png`));
}

function createTray(ctl) {
  try {
    ctl.tray = new Tray(trayImage('idle'));
  } catch (err) {
    ctl.log(`no tray: ${err.message}`);
    return;
  }
  ctl.tray.setToolTip('honeybee');
  ctl.tray.on('click', () => {
    if (process.platform === 'darwin') return;
    if (ctl.main && !ctl.main.isDestroyed() && ctl.main.isVisible() && ctl.main.isFocused()) collapse(ctl);
    else ctl.showMain();
  });
  updateTray(ctl, snapshotOf(ctl));
}

function trayMenu(ctl) {
  const st = ctl.settings.data;
  const toggle = (key) => (item) => setSetting(ctl, key, item.checked);
  return Menu.buildFromTemplate([
    { label: 'Open honeybee', click: () => ctl.showMain() },
    { type: 'separator' },
    { label: 'Collapse to a bubble when closed', type: 'checkbox', checked: st.bubbleOnClose, click: toggle('bubbleOnClose') },
    { label: 'Alert when an agent needs you', type: 'checkbox', checked: st.notifyNeedsYou, click: toggle('notifyNeedsYou') },
    { label: 'Alert when an agent finishes', type: 'checkbox', checked: st.notifyDone, click: toggle('notifyDone') },
    { type: 'separator' },
    { label: 'Quit honeybee', click: () => { ctl.quitting = true; app.quit(); } }
  ]);
}

let lastTrayState = null;
function updateTray(ctl, snapshot) {
  if (!ctl.tray || ctl.tray.isDestroyed?.()) return;
  const c = snapshot.counts;
  const state = c['needs-you'] > 0 ? 'needs' : c.working > 0 ? 'working' : 'idle';
  if (state !== lastTrayState) {
    ctl.tray.setImage(trayImage(state));
    lastTrayState = state;
  }
  const parts = [];
  if (c['needs-you']) parts.push(`${c['needs-you']} need${c['needs-you'] === 1 ? 's' : ''} you`);
  if (c.working) parts.push(`${c.working} working`);
  if (!parts.length) parts.push(c.total ? 'all quiet' : 'no agents yet');
  ctl.tray.setToolTip(`honeybee — ${parts.join(', ')}`);
  const st = ctl.settings.data;
  const menuKey = `${st.bubbleOnClose}${st.notifyNeedsYou}${st.notifyDone}`;
  if (menuKey !== lastMenuKey) {
    ctl.tray.setContextMenu(trayMenu(ctl));
    lastMenuKey = menuKey;
  }
}
let lastMenuKey = null;

// ---- settings and IPC -------------------------------------------------------

function setSetting(ctl, key, value) {
  if (!SETTING_TYPES[key] || !SETTING_TYPES[key](value)) return false;
  ctl.settings.set(key, value);
  if (key === 'theme') nativeTheme.themeSource = value;
  if (key === 'alwaysOnTop' && ctl.main && !ctl.main.isDestroyed()) ctl.main.setAlwaysOnTop(value);
  if (key === 'bubbleOnClose') {
    if (!value) releaseFold(ctl);
    else if (ctl.main && !ctl.main.isDestroyed() && ctl.main.isVisible()) prepareFold(ctl);
  }
  if (key === 'launchAtLogin') {
    try { autostart.setLaunchAtLogin(app, value); } catch (err) { ctl.log(`autostart: ${err.message}`); }
  }
  changed(ctl);
  return true;
}

function fromOurWindow(ctl, event) {
  const wc = event.sender;
  return (ctl.main && !ctl.main.isDestroyed() && wc === ctl.main.webContents)
    || (ctl.bubble && !ctl.bubble.isDestroyed() && wc === ctl.bubble.webContents);
}

function setupIpc(ctl, env) {
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    if (!fromOurWindow(ctl, event)) throw new Error('not allowed');
    return fn(...args);
  });
  const on = (channel, fn) => ipcMain.on(channel, (event, ...args) => {
    if (fromOurWindow(ctl, event)) fn(...args);
  });

  handle('state:get', () => snapshotOf(ctl));
  handle('settings:set', (key, value) => setSetting(ctl, key, value));
  handle('session:dismiss', (key) => { if (typeof key === 'string') ctl.agents.dismiss(key); });
  handle('integration:connect', (agent, opts) => connect(ctl, agent, opts || {}));
  handle('integration:disconnect', (agent) => disconnect(ctl, agent));
  handle('server:retry', () => moveToFreePort(ctl, env));
  handle('app:check-update', () => checkForUpdate(ctl, true));
  handle('app:open-external', (url) => {
    if (typeof url === 'string' && EXTERNAL_ALLOWED.some((re) => re.test(url))) shell.openExternal(url);
  });
  handle('app:show-file', (which) => {
    const file = which === 'codex' ? paths.codexHooksPath() : paths.claudeSettingsPath();
    if (fs.existsSync(file)) shell.showItemInFolder(file);
  });

  on('window:action', (action) => {
    if (!ctl.main || ctl.main.isDestroyed()) return;
    if (action === 'minimize') ctl.main.minimize();
    if (action === 'close') collapse(ctl);
    if (action === 'quit') { ctl.quitting = true; app.quit(); }
  });

  // The bubble is dragged by hand rather than with -webkit-app-region, so a
  // click on it still reaches the page.
  let drag = null;
  on('bubble:pointer', (phase) => {
    const b = ctl.bubble;
    if (!b || b.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    if (phase === 'down') {
      const [x, y] = b.getPosition();
      drag = { dx: cursor.x - x, dy: cursor.y - y, startX: cursor.x, startY: cursor.y, moved: false };
    } else if (phase === 'move' && drag) {
      if (Math.abs(cursor.x - drag.startX) + Math.abs(cursor.y - drag.startY) > 4) drag.moved = true;
      if (drag.moved) b.setPosition(Math.round(cursor.x - drag.dx), Math.round(cursor.y - drag.dy));
    } else if (phase === 'cancel') {
      drag = null;
    } else if (phase === 'up' && drag) {
      const wasClick = !drag.moved;
      drag = null;
      if (wasClick) ctl.showMain();
      else {
        const [x, y] = b.getPosition();
        ctl.settings.set('bubblePosition', { x, y });
      }
    }
  });
  on('bubble:menu', () => {
    const b = ctl.bubble;
    if (!b || b.isDestroyed()) return;
    Menu.buildFromTemplate([
      { label: 'Open honeybee', click: () => ctl.showMain() },
      { label: 'Hide the bubble', click: () => hideBubble(ctl) },
      { type: 'separator' },
      { label: 'Quit honeybee', click: () => { ctl.quitting = true; app.quit(); } }
    ]).popup({ window: b });
  });
}

function connect(ctl, agent, opts) {
  if (!ctl.server) return { ok: false, message: ctl.serverError || 'honeybee is not listening yet.' };
  const port = ctl.server.port;
  const token = ctl.settings.get('token');
  try {
    if (agent === 'claude') {
      const result = integrations.installClaude({ file: paths.claudeSettingsPath(), port, token, replaceStatusLine: Boolean(opts.replaceStatusLine) });
      const prev = ctl.settings.get('claude') || {};
      ctl.settings.set('claude', {
        connected: true,
        connectedAt: Date.now(),
        previousStatusLine: result.previousStatusLine || prev.previousStatusLine || null
      });
      ctl.settings.saveNow();
      changed(ctl);
      return { ok: true, ...result };
    }
    if (agent === 'codex') {
      const result = integrations.installCodex({ file: paths.codexHooksPath(), port, token });
      ctl.settings.set('codex', { connected: true, connectedAt: Date.now() });
      ctl.settings.saveNow();
      changed(ctl);
      return { ok: true, ...result };
    }
    return { ok: false, message: 'Unknown agent.' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

function disconnect(ctl, agent) {
  try {
    if (agent === 'claude') {
      const prev = ctl.settings.get('claude') || {};
      const result = integrations.uninstallClaude({ file: paths.claudeSettingsPath(), previousStatusLine: prev.previousStatusLine });
      ctl.settings.set('claude', { connected: false, connectedAt: null, previousStatusLine: null });
      ctl.settings.saveNow();
      changed(ctl);
      return { ok: true, ...result };
    }
    if (agent === 'codex') {
      const result = integrations.uninstallCodex({ file: paths.codexHooksPath() });
      ctl.settings.set('codex', { connected: false, connectedAt: null });
      ctl.settings.saveNow();
      changed(ctl);
      return { ok: true, ...result };
    }
    return { ok: false, message: 'Unknown agent.' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// ---- updates ----------------------------------------------------------------

async function checkForUpdate(ctl, manual = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await net.fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
      headers: { 'User-Agent': `honeybee/${ctl.version}`, Accept: 'application/vnd.github+json' },
      signal: controller.signal
    });
    const decision = parseReleaseResponse(await res.text(), ctl.version);
    ctl.update = decision.hasUpdate ? { version: decision.version, url: releasesUrlFor(OWNER, REPO) } : null;
    changed(ctl);
    return { ok: true, update: ctl.update, reason: decision.reason };
  } catch (err) {
    return { ok: false, message: manual ? `Could not check for updates: ${err.message}` : null };
  } finally {
    clearTimeout(timer);
  }
}

// ---- packaged self-test -----------------------------------------------------

// `honeybee --self-test=<file>`: start for real, prove the window rendered and
// the server answers, write the result, quit. Used by CI on packaged builds.
async function runSelfTest(ctl, file) {
  const result = { version: ctl.version, platform: process.platform, arch: process.arch, ok: false, steps: {} };
  const finish = () => {
    try { fs.writeFileSync(file, JSON.stringify(result, null, 2)); } catch (_) { /* nowhere to report */ }
    ctl.quitting = true;
    app.quit();
  };
  const watchdog = setTimeout(() => { result.steps.watchdog = 'timed out'; finish(); }, 45000);
  try {
    result.steps.server = ctl.server ? `listening on ${ctl.server.port}` : `not listening: ${ctl.serverError}`;
    const win = ctl.main;
    await new Promise((resolve) => {
      if (!win.webContents.isLoading()) resolve();
      else win.webContents.once('did-finish-load', resolve);
    });
    await new Promise((r) => setTimeout(r, 800));
    result.steps.rendered = await win.webContents.executeJavaScript('Boolean(document.querySelector(".app[data-ready]"))');
    if (ctl.server) {
      const res = await net.fetch(`http://127.0.0.1:${ctl.server.port}/health`, { headers: { 'X-Honeybee': ctl.settings.get('token') } });
      result.steps.health = res.status;
    }
    // Where the fold animates, give it the moment it needs to get ready.
    for (let waited = 0; waited < 8000 && !ctl.foldLoaded && foldPossible(ctl); waited += 250) {
      await new Promise((r) => setTimeout(r, 250));
    }
    collapse(ctl);
    const bubbleShown = () => Boolean(ctl.bubble && !ctl.bubble.isDestroyed() && ctl.bubble.isVisible());
    for (let waited = 0; waited < 10000 && (!bubbleShown() || ctl.folding); waited += 250) {
      await new Promise((r) => setTimeout(r, 250));
    }
    result.steps.bubble = bubbleShown();
    result.steps.fold = ctl.lastFold;
    result.steps.tray = Boolean(ctl.tray);
    result.ok = Boolean(result.steps.rendered && result.steps.health === 200 && result.steps.bubble);
  } catch (err) {
    result.steps.error = err.stack || err.message;
  }
  clearTimeout(watchdog);
  finish();
}

module.exports = { start, collapse, showBubble, hideBubble, snapshotOf, connect, disconnect, setSetting, DEFAULT_PORT };
