'use strict';

// End to end, in a real Electron: the app starts on an isolated home folder
// with fake Claude Code and Codex files, receives real hook requests over
// HTTP, and the test reads what the window and the bubble actually show.
//
//   electron test/electron-smoke.js                 assertions only
//   electron test/electron-smoke.js --screens DIR   also save screenshots

const { app, Notification, systemPreferences } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// A headless Linux runner has no GPU, and Chromium's page capture fails there
// unless it renders in software from the start.
if (process.platform === 'linux') app.disableHardwareAcceleration();

// On someone's own desktop the test's notifications are only noise: with
// HONEYBEE_SMOKE_QUIET they are built and counted but never shown.
if (process.env.HONEYBEE_SMOKE_QUIET) Notification.prototype.show = function show() {};

const screensAt = process.argv.indexOf('--screens');
const screensDir = screensAt > 0 ? path.resolve(process.argv[screensAt + 1] || 'test-results/screenshots') : null;

// ---- an isolated world --------------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'honeybee-smoke-'));
const home = path.join(root, 'home');
const claudeDir = path.join(home, '.claude');
const codexDir = path.join(home, '.codex');
const now = Date.now();

const userSettings = {
  model: 'opus',
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/guard.sh' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'python', args: ['C:\\fun\\claude_status_widget.py', 'hook'] }] }]
  }
};
fs.mkdirSync(claudeDir, { recursive: true });
fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(userSettings, null, 2));

// A Claude session that finished a minute ago.
const slugDir = path.join(claudeDir, 'projects', '-work-shop');
fs.mkdirSync(slugDir, { recursive: true });
fs.writeFileSync(path.join(slugDir, 'seed-claude.jsonl'), [
  { type: 'user', message: { content: 'tidy the css' }, cwd: '/work/shop', timestamp: new Date(now - 90000).toISOString() },
  { type: 'ai-title', aiTitle: 'Tidy the stylesheet' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] }, cwd: '/work/shop', timestamp: new Date(now - 60000).toISOString() }
].map((e) => JSON.stringify(e)).join('\n') + '\n');

// A Codex session with its rate limits.
const d = new Date(now);
const dayDir = path.join(codexDir, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
fs.mkdirSync(dayDir, { recursive: true });
const ts = new Date(now - 30000).toISOString();
fs.writeFileSync(path.join(dayDir, 'rollout-smoke-codex.jsonl'), [
  { timestamp: ts, type: 'session_meta', payload: { id: 'codex-smoke', cwd: path.join(root, 'site'), originator: 'codex_cli', timestamp: ts } },
  { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'rename the article files' }] } },
  { timestamp: ts, type: 'event_msg', payload: { type: 'task_started', turn_id: 't', started_at: (now - 30000) / 1000 } },
  { timestamp: ts, type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'codex', plan_type: 'plus',
    primary: { used_percent: 7, window_minutes: 300, resets_at: Math.round(now / 1000) + 3 * 3600 },
    secondary: { used_percent: 20, window_minutes: 10080, resets_at: Math.round(now / 1000) + 4 * 86400 } } } },
  { timestamp: ts, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't', last_agent_message: 'Renamed five files.', completed_at: (now - 20000) / 1000 } }
].map((e) => JSON.stringify(e)).join('\n') + '\n');

process.env.HONEYBEE_HOME = home;
process.env.HONEYBEE_USER_DATA = path.join(root, 'userData');
process.env.HONEYBEE_PORT = '0';
process.env.HONEYBEE_OFFLINE = '1';
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;

// ---- harness ----------------------------------------------------------------------

const results = [];
let failures = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail && !ok ? `\n        ${detail}` : ''}`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    let value;
    try { value = await fn(); } catch (_) { value = null; }
    if (value) return value;
    if (Date.now() > end) return value;
    await wait(80);
  }
}

function post(port, token, route, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: { 'X-Honeybee': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const js = (win, code) => win.webContents.executeJavaScript(code);

// Screenshots are evidence for a person to look at, not assertions: a capture
// that the platform can't produce is reported and the run carries on.
async function capture(win, name) {
  if (!screensDir) return;
  fs.mkdirSync(screensDir, { recursive: true });
  await wait(350);
  try {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(screensDir, `${name}.png`), image.toPNG());
  } catch (err) {
    console.log(`  note  could not capture ${name}: ${err.message}`);
  }
}

// ---- the run --------------------------------------------------------------------

const honeybee = require('../src/main/app');
const ctl = honeybee.start({ argv: ['electron', 'honeybee'] });

setTimeout(() => {
  console.log('  FAIL  watchdog: the smoke test did not finish in 120s');
  app.exit(2);
}, 120000).unref();

ctl.ready.then(async () => {
  try {
    await run();
  } catch (err) {
    check('no unexpected error', false, err.stack);
  }
  console.log(`\nelectron smoke: ${results.length - failures}/${results.length} passed`);
  if (screensDir) console.log(`screenshots in ${screensDir}`);
  ctl.quitting = true;
  app.exit(failures ? 1 : 0);
});

async function run() {
  const port = ctl.server && ctl.server.port;
  const token = ctl.settings.get('token');
  check('the server is listening on 127.0.0.1', port > 0, ctl.serverError);

  const main = ctl.main;
  await until(() => !main.webContents.isLoading());
  await until(() => js(main, 'Boolean(document.querySelector(".app[data-ready]"))'));
  check('the window rendered', await js(main, 'Boolean(document.querySelector(".app[data-ready]"))'));

  // What was found on disk before any hook fired.
  const snap0 = honeybee.snapshotOf(ctl);
  const codexUsage = snap0.usage.codex;
  check('codex limits are read from its own session log', codexUsage && codexUsage.windows[0].usedPercent === 7 && codexUsage.windows[1].usedPercent === 20,
    JSON.stringify(codexUsage));
  check('the codex session from the log is listed as done', snap0.agents.some((s) => s.key === 'codex:codex-smoke' && s.status === 'done' && s.title === 'rename the article files'),
    JSON.stringify(snap0.agents));
  check('the recent claude transcript is listed with its title', snap0.agents.some((s) => s.key === 'claude:seed-claude' && s.title === 'Tidy the stylesheet' && s.status === 'done'),
    JSON.stringify(snap0.agents));
  check('the window shows both sessions', await until(() => js(main, 'document.querySelectorAll(".session").length === 2')));

  // Connecting edits the user's real files carefully.
  const claudeResult = honeybee.connect(ctl, 'claude', {});
  const settingsFile = path.join(claudeDir, 'settings.json');
  const written = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  check('connecting claude code adds hooks and the status line', claudeResult.ok && written.hooks.Stop.some((g) => g.hooks.some((h) => h.type === 'http')) && /curl/.test(written.statusLine.command),
    JSON.stringify(claudeResult));
  check('the user\'s own hook survives, the old python widget\'s is replaced', written.hooks.PreToolUse.some((g) => g.hooks[0].command === '~/guard.sh')
    && !JSON.stringify(written).includes('claude_status_widget.py'));
  check('the original settings file is backed up', fs.existsSync(`${settingsFile}.before-honeybee`));
  const codexResult = honeybee.connect(ctl, 'codex', {});
  check('connecting codex writes its hooks file', codexResult.ok && fs.existsSync(path.join(codexDir, 'hooks.json')), JSON.stringify(codexResult));

  // A live Claude session asks for approval.
  const base = { session_id: 'live-1', cwd: path.join(root, 'honeybee'), transcript_path: path.join(root, 'nope.jsonl') };
  let res = await post(port, token, '/claude/hook', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'Ship the widget' });
  check('a hook request is answered with an empty 200', res.status === 200 && res.text === '', JSON.stringify(res));
  await post(port, token, '/claude/hook', { ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 'tu-1' });
  const needsRow = await until(() => js(main, `(() => { const r = document.querySelector('.session[data-status="needs-you"]'); return r && r.textContent; })()`));
  check('the window shows the session that needs you', needsRow && needsRow.includes('Ship the widget') && needsRow.includes('approve a command'), String(needsRow));
  check('it is listed first', await js(main, `document.querySelector('.session').dataset.status === 'needs-you'`));
  check('the tab shows how many need you', (await js(main, `document.getElementById('tab-count').textContent`)) === '1');
  const bad = await post(port, 'wrong-token', '/claude/hook', { ...base, hook_event_name: 'Stop' });
  check('a request without the token is refused', bad.status === 401);

  // Claude Code's status line feed.
  res = await post(port, token, '/claude/statusline', {
    session_id: 'live-1', model: { display_name: 'Opus 5.5' }, context_window: { used_percentage: 38 },
    rate_limits: { five_hour: { used_percentage: 23, resets_at: Math.round(Date.now() / 1000) + 7800 }, seven_day: { used_percentage: 61, resets_at: Math.round(Date.now() / 1000) + 3 * 86400 } }
  });
  check('the status line gets its text back', res.text === 'Opus 5.5 · ctx 38% · 5h 23% · wk 61%', res.text);
  honeybee.setSetting(ctl, 'view', 'usage');
  const usageText = await until(() => js(main, `(() => { const p = document.getElementById('providers'); return p && p.textContent.includes('77%') && p.textContent; })()`));
  check('the usage view shows what is left', usageText && usageText.includes('77%') && usageText.includes('39%') && usageText.includes('93%'), String(usageText));
  ctl.usage.claude.observedAt = Date.now() - 40 * 60 * 1000;
  honeybee.setSetting(ctl, 'view', 'usage');
  const note = await until(() => js(main, `(() => { const n = document.querySelector('.provider-note'); return n && n.textContent; })()`));
  check('an old claude reading says how to get a fresh one', note && note.includes('terminal'), String(note));
  ctl.usage.claude.observedAt = Date.now();
  honeybee.setSetting(ctl, 'view', 'usage');
  check('each window is a honeycomb of ten cells', (await js(main, 'document.querySelectorAll(".window").length')) === 4
    && (await js(main, 'document.querySelector(".comb").children.length')) === 10);

  // Responsive: wide shows both panels; narrow shows tabs.
  main.setSize(720, 480);
  await wait(300);
  check('wide: agents and usage side by side, no tabs', await js(main, `getComputedStyle(document.querySelector('.tabs')).display === 'none'
    && getComputedStyle(document.querySelector('.agents-panel')).display !== 'none'
    && getComputedStyle(document.querySelector('.usage-panel')).display !== 'none'`));
  const bar = await js(main, `(() => { const d = document.getElementById('divider').getBoundingClientRect(); const c = document.querySelector('.content').getBoundingClientRect(); return { x: d.left, y: d.top + d.height / 2, left: c.left, width: c.width }; })()`);
  const agentsWidth = () => js(main, `document.querySelector('.agents-panel').getBoundingClientRect().width`);
  const agentsBefore = await agentsWidth();
  const at = (x) => ({ x: Math.round(x), y: Math.round(bar.y) });
  main.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at(bar.x) });
  for (const dx of [-30, -60, -100]) {
    main.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], ...at(bar.x + dx) });
    await wait(40);
  }
  main.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...at(bar.x - 100) });
  await wait(300);
  const split = ctl.settings.get('split');
  const agentsAfter = await agentsWidth();
  check('the divider can be dragged, and its place is kept', split !== null && Math.abs(split - (bar.x - 100 - bar.left) / bar.width) < 0.03 && agentsAfter < agentsBefore - 60,
    `split ${split}, agents panel ${agentsBefore} -> ${agentsAfter}`);
  await js(main, `document.getElementById('divider').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await wait(300);
  check('a double-click puts the divider back', ctl.settings.get('split') === null && Math.abs((await agentsWidth()) - agentsBefore) < 2);
  if (screensDir) {
    await sampleSessions(port, token);
    for (const theme of ['dark', 'light']) {
      honeybee.setSetting(ctl, 'theme', theme);
      honeybee.setSetting(ctl, 'view', 'agents');
      await wait(300);
      main.setSize(720, 480); await capture(main, `wide-${theme}`);
      main.setSize(380, 560); await capture(main, `narrow-agents-${theme}`);
      honeybee.setSetting(ctl, 'view', 'usage');
      await capture(main, `narrow-usage-${theme}`);
      main.setSize(300, 240); await capture(main, `tiny-usage-${theme}`);
      honeybee.setSetting(ctl, 'view', 'agents');
      await capture(main, `tiny-agents-${theme}`);
    }
    honeybee.setSetting(ctl, 'theme', 'system');
    main.setSize(380, 560);
    await js(main, `document.querySelector('[data-action="settings"]').click()`);
    await capture(main, 'settings');
    await js(main, `document.querySelector('[data-action="settings-done"]').click()`);
  }
  main.setSize(340, 520);
  await wait(300);
  check('narrow: tabs are shown', await js(main, `getComputedStyle(document.querySelector('.tabs')).display !== 'none'`));

  honeybee.setSetting(ctl, 'theme', 'light');
  await wait(300);
  const lightBg = await js(main, 'getComputedStyle(document.body).backgroundColor');
  check('the light theme applies', lightBg === 'rgb(242, 237, 234)', lightBg);
  honeybee.setSetting(ctl, 'theme', 'dark');
  await wait(300);
  const darkBg = await js(main, 'getComputedStyle(document.body).backgroundColor');
  check('the dark theme applies', darkBg === 'rgb(21, 17, 14)', darkBg);

  // Text size: the setting, and Ctrl + / Ctrl 0.
  honeybee.setSetting(ctl, 'zoom', 1.2);
  await wait(200);
  check('a bigger text size zooms the window', Math.abs(main.webContents.getZoomFactor() - 1.2) < 0.001, String(main.webContents.getZoomFactor()));
  for (const keyCode of ['=', '0']) {
    main.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['control'] });
    main.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['control'] });
    await wait(200);
    if (keyCode === '=') check('Ctrl + makes the text bigger', ctl.settings.get('zoom') === 1.3, String(ctl.settings.get('zoom')));
  }
  check('Ctrl 0 puts the text back to normal', ctl.settings.get('zoom') === 1 && Math.abs(main.webContents.getZoomFactor() - 1) < 0.001, String(ctl.settings.get('zoom')));

  // X folds the window into the bubble: animated on Windows and macOS,
  // straight away elsewhere, and wherever the system asks for less motion
  // (as CI machines often do).
  const motion = systemPreferences.getAnimationSettings();
  const folds = (process.platform === 'win32' || process.platform === 'darwin') && !motion.prefersReducedMotion;
  if (!folds) console.log(`  skip  the fold animation: ${process.platform}, reduced motion ${motion.prefersReducedMotion}`);
  if (folds) check('the fold is made ready while the window is open', Boolean(await until(() => ctl.foldLoaded, 8000)));
  const placeBefore = JSON.stringify(main.getBounds());
  main.close();
  if (folds && screensDir) await captureFold();
  check('closing the window hides it instead of quitting', Boolean(await until(() => !main.isDestroyed() && !main.isVisible(), 3000)));
  const bubble = await until(() => ctl.bubble && !ctl.bubble.isDestroyed() && ctl.bubble.isVisible() && ctl.bubble, 8000);
  check('the bubble appears', Boolean(bubble));
  if (folds) {
    await until(() => !ctl.folding, 8000);
    const fold = ctl.lastFold || {};
    check('the window folded into the bubble, animated', fold.played && !fold.error && fold.handedOverAfterMs > 0, JSON.stringify(fold));
    check('the fold layer is emptied and parked once the bubble has taken over', Boolean(ctl.fold && !ctl.fold.isDestroyed() && ctl.fold.getBounds().width < 64 && ctl.fold.getBounds().height < 64), JSON.stringify(ctl.fold && ctl.fold.getBounds()));
    check('the window keeps its place for next time', JSON.stringify(main.getBounds()) === placeBefore);
  }
  if (bubble) {
    await until(() => !bubble.webContents.isLoading());
    const bubbleState = await until(() => js(bubble, `document.getElementById('bubble').dataset.state === 'needs' && document.getElementById('count').textContent`));
    check('the bubble says one session needs you', bubbleState === (screensDir ? '2' : '1'), String(bubbleState));
    await capture(bubble, 'bubble-needs');
    honeybee.setSetting(ctl, 'zoom', 1.3);
    await wait(200);
    check('the bubble keeps its size when the text is bigger', Math.abs(bubble.webContents.getZoomFactor() - 1) < 0.001, String(bubble.webContents.getZoomFactor()));
    honeybee.setSetting(ctl, 'zoom', 1);
  }

  // Approve, finish: the bubble calms down.
  await post(port, token, '/claude/hook', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu-1' });
  if (screensDir) await post(port, token, '/claude/hook', { session_id: 'demo-needs', hook_event_name: 'SessionEnd' });
  await until(() => honeybee.snapshotOf(ctl).agents.find((s) => s.key === 'claude:live-1').status === 'working');
  check('approving moves the session back to working', honeybee.snapshotOf(ctl).agents.find((s) => s.key === 'claude:live-1').status === 'working');
  if (bubble && !bubble.isDestroyed()) {
    const working = await until(() => js(bubble, `document.getElementById('bubble').dataset.state === 'working'`));
    check('the bubble shows work in progress', Boolean(working));
    await capture(bubble, 'bubble-working');
  }
  const notifiedBefore = ctl.notified || 0;
  await post(port, token, '/claude/hook', { ...base, hook_event_name: 'Stop', last_assistant_message: 'Shipped.' });
  await until(() => honeybee.snapshotOf(ctl).agents.find((s) => s.key === 'claude:live-1').status === 'done');
  check('the finished session shows its last message', honeybee.snapshotOf(ctl).agents.find((s) => s.key === 'claude:live-1').lastMessage === 'Shipped.');
  if (Notification.isSupported()) {
    await wait(1000);
    check('"finished" waits a moment before notifying', (ctl.notified || 0) === notifiedBefore);
    const fired = await until(() => (ctl.notified || 0) > notifiedBefore, 4000);
    check('then the finished notification is sent', Boolean(fired), `notified ${ctl.notified}`);
  } else {
    console.log('  skip  notifications are not supported on this machine');
  }

  // Clicking the bubble brings the window back: the bee flies out of the hive.
  honeybee.openFromBubble(ctl);
  if (folds) {
    await until(() => ctl.lastUnfold && !ctl.unfolding && main.isVisible(), 4000);
    const unfold = ctl.lastUnfold || {};
    check('the bee flies out of the hive and the window opens', unfold.played && !unfold.error && unfold.openedAfterMs > 0, JSON.stringify(unfold));
  }
  await until(() => main.isVisible() && (!ctl.bubble || ctl.bubble.isDestroyed()), 4000);
  check('the window comes back and the bubble goes', main.isVisible() && (!ctl.bubble || ctl.bubble.isDestroyed()));

  // Opening the window while it is still folding stops the fold.
  if (folds && await until(() => ctl.foldLoaded, 8000)) {
    honeybee.collapse(ctl);
    await wait(40);
    ctl.showMain();
    await wait(500);
    check('opening the window mid-fold stops the fold', main.isVisible() && !ctl.folding && (!ctl.bubble || ctl.bubble.isDestroyed()),
      `visible ${main.isVisible()}, folding ${Boolean(ctl.folding)}, bubble ${Boolean(ctl.bubble)}`);
  }

  // Disconnecting puts the user's files back.
  honeybee.disconnect(ctl, 'claude');
  honeybee.disconnect(ctl, 'codex');
  const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  check('disconnecting removes only honeybee', !JSON.stringify(after).includes('/claude/hook') && after.statusLine === undefined
    && after.hooks.PreToolUse[0].hooks[0].command === '~/guard.sh' && after.model === 'opus', JSON.stringify(after));

  check('state is saved to disk', ctl.state.saveNow() && fs.existsSync(path.join(root, 'userData', 'state.json')));
}

// Frames of the fold as it plays, for a person to look at.
async function captureFold() {
  await until(() => ctl.lastFold && ctl.lastFold.played, 3000);
  const layer = ctl.fold;
  for (let frame = 1; frame <= 8 && layer && !layer.isDestroyed(); frame += 1) {
    try {
      const image = await layer.webContents.capturePage();
      fs.writeFileSync(path.join(screensDir, `fold-${frame}.png`), image.toPNG());
    } catch (err) {
      console.log(`  note  could not capture fold frame ${frame}: ${err.message}`);
    }
    await wait(90);
  }
}

// Extra sessions so the screenshots show every state.
async function sampleSessions(port, token) {
  const s = (id, extra) => post(port, token, '/claude/hook', { session_id: id, cwd: path.join(root, extra.dir || 'honeybee'), transcript_path: path.join(root, 'x.jsonl'), ...extra });
  await s('demo-needs', { dir: 'checkout', hook_event_name: 'UserPromptSubmit', prompt: 'Fix the flaky checkout test' });
  await s('demo-needs', { dir: 'checkout', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'q1' });
  await s('demo-work', { dir: 'parser', hook_event_name: 'UserPromptSubmit', prompt: 'Refactor the rollout parser' });
  await post(port, token, '/codex/hook', { session_id: 'demo-codex', cwd: path.join(root, 'site'), hook_event_name: 'UserPromptSubmit', prompt: 'Make the landing page responsive' });
  await s('demo-fail', { dir: 'docs', hook_event_name: 'UserPromptSubmit', prompt: 'Draft the release notes' });
  await s('demo-fail', { dir: 'docs', hook_event_name: 'StopFailure', error_type: 'overloaded' });
  await wait(300);
  // Spread the clocks out so the pictures look like a real afternoon.
  const ago = { 'claude:demo-needs': 95e3, 'claude:live-1': 40e3, 'claude:demo-work': 6.5 * 60e3, 'codex:demo-codex': 13 * 60e3,
    'claude:demo-fail': 4 * 60e3, 'codex:codex-smoke': 22 * 60e3, 'claude:seed-claude': 48 * 60e3 };
  for (const [key, ms] of Object.entries(ago)) {
    const session = ctl.agents.sessions.get(key);
    if (session) session.statusSince = Date.now() - ms;
  }
  ctl.agents.onChange();
  await wait(300);
}
