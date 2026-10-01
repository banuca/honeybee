'use strict';

// The main window. Plain DOM, no framework: the state arrives whole from the
// main process and the page redraws what changed. Every string that came from
// an agent (titles, messages, folders) goes in through textContent only.

const api = window.honeybee;
const root = document.getElementById('app');

let state = null;
let settingsOpen = false;
const ui = { confirm: null, replaceStatusLine: false, messages: {}, busy: null };

// ---- tiny DOM helpers ----------------------------------------------------------

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(viewBox, ...paths) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('aria-hidden', 'true');
  for (const [cls, d] of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    if (cls) p.setAttribute('class', cls);
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}

const HEX = 'M6 .6 10.7 3.3v5.4L6 11.4 1.3 8.7V3.3Z';
const MARKS = {
  'needs-you': 'M6 3.4v3.3M6 8.2v.3',
  done: 'M3.9 6.1 5.4 7.6 8.2 4.6',
  failed: 'M4.4 4.4l3.2 3.2M7.6 4.4 4.4 7.6'
};

function glyph(status) {
  const filled = status === 'needs-you' || status === 'done' || status === 'failed';
  const paths = [[filled ? 'g-cell' : 'g-ring', HEX]];
  if (status === 'working') paths.push(['g-seg', HEX]);
  if (MARKS[status]) paths.push(['g-mark', MARKS[status]]);
  return h('span', { class: 'glyph', dataset: { g: status, phase: '0' } }, svg('0 0 12 12', ...paths));
}

const CLOSE_ICON = () => svg('0 0 12 12', [null, 'M3 3l6 6M9 3 3 9']);

// ---- formatting ------------------------------------------------------------------

let clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
let weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
let localeInUse = null;

function useLocale(locale) {
  if (!locale || locale === localeInUse) return;
  try {
    clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
    weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' });
    localeInUse = locale;
  } catch (_) { /* keep the default */ }
}

function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return m % 60 ? `${hrs}h ${m % 60}m` : `${hrs}h`;
  const d = Math.floor(hrs / 24);
  return hrs % 24 ? `${d}d ${hrs % 24}h` : `${d}d`;
}

function sinceText(session, now) {
  const age = now - (session.statusSince || session.updatedAt || now);
  if (session.status === 'working' || session.status === 'needs-you') return span(age);
  return age < 45000 ? 'just now' : `${span(age)} ago`;
}

function resetText(w, now) {
  if (!w.resetsAt) return '';
  if (w.reset) return `reset at ${clock.format(w.resetsAt)}, waiting for a fresh reading`;
  const left = w.resetsAt - now;
  if (left < 24 * 3600 * 1000) return `resets in ${span(left)}`;
  return `resets ${weekday.format(w.resetsAt).toLowerCase()} ${clock.format(w.resetsAt)}`;
}

function readText(observedAt, now) {
  if (!observedAt) return '';
  const age = now - observedAt;
  if (age < 60000) return 'read just now';
  if (age < 6 * 3600 * 1000) return `read ${clock.format(observedAt)}`;
  return `read ${span(age)} ago`;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// ---- rendering -----------------------------------------------------------------

// Panels are rebuilt only when what they show has changed. Updates arrive
// several times a second while an agent works, and rebuilding a button between
// mouse-down and mouse-up would swallow the click.
const signatures = {};
function changedSince(name, ...parts) {
  const sig = JSON.stringify(parts);
  if (signatures[name] === sig) return false;
  signatures[name] = sig;
  return true;
}

// The connection facts a panel depends on, without the timestamps that change
// on every event (those are kept fresh by tick()).
function connections() {
  const out = {};
  for (const agent of ['claude', 'codex']) {
    const i = state.integrations[agent];
    out[agent] = { connected: i.connected, present: i.present, check: i.check, heard: Boolean(i.hookSeenAt) };
  }
  return out;
}

function render() {
  if (!state) return;
  useLocale(state.locale);
  const view = state.settings.view || 'agents';
  root.dataset.view = view;
  for (const tab of root.querySelectorAll('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.tab === view));
  const needs = state.counts['needs-you'];
  document.getElementById('tab-count').textContent = needs ? String(needs) : '';
  document.title = needs ? `honeybee (${needs})` : 'honeybee';
  renderAgents();
  renderUsage();
  renderStatusbar();
  const settings = document.getElementById('settings');
  settings.hidden = !settingsOpen;
  if (settingsOpen) renderSettings();
  root.dataset.ready = '';
}

const AGENT_TAG = { claude: 'claude', codex: 'codex' };

function whatText(s) {
  switch (s.status) {
    case 'needs-you': return s.reason || 'needs you';
    case 'working': return 'working';
    case 'done': return s.lastMessage || 'finished';
    case 'stopped': return 'stopped by you';
    case 'failed': return s.reason || 'stopped with an error';
    default: return 'idle';
  }
}

const rows = new Map();

function sessionRow(s) {
  const row = h('li', { class: 'session' });
  row.append(
    h('span', { class: 'glyph-slot' }),
    h('span', { class: 'title' }),
    h('span', { class: 'when' }),
    h('span', { class: 'detail' }, h('span', { class: 'what' }), h('span', { class: 'where' }), h('span', { class: 'tag' })),
    h('button', { class: 'dismiss', title: 'Hide until it does something', 'aria-label': 'Hide until it does something', onclick: () => api.dismiss(s.key) }, CLOSE_ICON())
  );
  return row;
}

function fillRow(row, s, now) {
  if (row.dataset.status !== s.status) {
    row.dataset.status = s.status;
    const slot = row.querySelector('.glyph-slot, .glyph');
    slot.replaceWith(glyph(s.status));
  }
  row.querySelector('.title').textContent = s.title || (s.project ? `session in ${s.project}` : 'new session');
  const when = row.querySelector('.when');
  when.textContent = sinceText(s, now);
  when.dataset.since = String(s.statusSince || '');
  when.dataset.live = s.status === 'working' || s.status === 'needs-you' ? '1' : '0';
  row.querySelector('.what').textContent = whatText(s);
  row.querySelector('.where').textContent = s.project || '';
  row.querySelector('.tag').textContent = `[${AGENT_TAG[s.agent] || s.agent}]`;
  const tip = [s.title, s.project, s.model, s.contextPercent !== null && s.contextPercent !== undefined ? `context ${Math.round(s.contextPercent)}% used` : null]
    .filter(Boolean).join('\n');
  row.title = tip;
  row.dataset.key = s.key;
}

function renderAgents() {
  const list = document.getElementById('sessions');
  const empty = document.getElementById('agents-empty');
  const sessions = state.agents;
  const now = Date.now();
  const c = state.counts;

  const meta = [];
  if (c['needs-you']) meta.push(`${c['needs-you']} need${c['needs-you'] === 1 ? 's' : ''} you`);
  if (c.working) meta.push(`${c.working} working`);
  document.getElementById('agents-meta').textContent = meta.join(', ');

  const seen = new Set();
  sessions.forEach((s, index) => {
    seen.add(s.key);
    let row = rows.get(s.key);
    if (!row) {
      row = sessionRow(s);
      rows.set(s.key, row);
    }
    fillRow(row, s, now);
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
  });
  for (const [key, row] of rows) {
    if (!seen.has(key)) {
      row.remove();
      rows.delete(key);
    }
  }

  const integ = state.integrations;
  if (!changedSince('setup', sessions.length === 0, connections(), state.server.listening, ui)) return;
  empty.replaceChildren();
  if (!sessions.length) {
    empty.hidden = false;
    if (!integ.claude.connected && !integ.codex.connected) {
      empty.append(h('p', { text: 'Connect your agents and they show up here the moment they start work, need you, or finish.' }));
    } else {
      empty.append(h('p', { text: 'No agents yet. Send a prompt in Claude Code or Codex and it appears here.' }));
    }
    for (const agent of ['claude', 'codex']) {
      if (!integ[agent].connected) empty.append(setupStep(agent));
    }
  } else {
    const missing = ['claude', 'codex'].filter((a) => !integ[a].connected && integ[a].present);
    empty.hidden = missing.length === 0;
    for (const agent of missing) empty.append(setupStep(agent, { compact: true }));
  }
}

const NAMES = { claude: 'Claude Code', codex: 'Codex' };
const FILES = { claude: '~/.claude/settings.json', codex: '~/.codex/hooks.json' };

function setupStep(agent, { compact = false } = {}) {
  const integ = state.integrations[agent];
  const body = h('div');
  body.append(h('h3', { text: `connect ${NAMES[agent].toLowerCase()}` }));
  if (!integ.present) {
    body.append(h('p', { text: `${NAMES[agent]} isn't set up on this computer yet. Once it is, connect it here.` }));
  } else if (!compact) {
    body.append(h('p', {
      text: agent === 'claude'
        ? 'Hooks tell honeybee the moment a session needs you or finishes, and Claude Code passes its usage limits along.'
        : 'Hooks tell honeybee the moment Codex needs your approval or finishes a turn.'
    }));
  }
  if (ui.confirm === agent) body.append(confirmBox(agent));
  else body.append(h('button', { class: 'button', onclick: () => { ui.confirm = agent; render(); } , disabled: !state.server.listening }, `connect ${NAMES[agent].toLowerCase()}`));
  if (ui.messages[agent]) body.append(h('p', { class: `message ${ui.messages[agent].ok ? 'is-ok' : 'is-error'}`, text: ui.messages[agent].text }));
  return h('div', { class: 'step' }, h('span', { class: 'step-mark', text: '[*]' }), body);
}

function confirmBox(agent) {
  const integ = state.integrations[agent];
  const items = agent === 'claude'
    ? [
      'hooks that tell honeybee when a session starts work, needs you, or finishes',
      'a status line that passes Claude Code\'s usage limits to honeybee from terminal sessions, and shows them there too',
      integ.check.pythonWidget ? 'and it replaces your old status widget\'s hooks' : null
    ]
    : [
      'hooks that hand each Codex event to honeybee with curl, in the background',
      'Codex runs new hooks only after you trust them: type /hooks in Codex once'
    ];
  const box = h('div', { class: 'confirm' },
    h('p', { text: `honeybee will add to ${FILES[agent]}:` }),
    h('ul', {}, items.filter(Boolean).map((t) => h('li', { text: t }))),
    h('p', { class: 'quiet', text: `Your current file is kept as ${FILES[agent].split('/').pop()}.before-honeybee.` })
  );
  if (agent === 'claude' && integ.check.statusLine === 'other') {
    const input = h('input', { type: 'checkbox', onchange: (e) => { ui.replaceStatusLine = e.target.checked; } });
    input.checked = ui.replaceStatusLine;
    box.append(h('label', { class: 'toggle' }, input, h('span', { text: 'Replace my own status line (it comes back when you disconnect). Without this, Claude\'s limits can\'t reach honeybee.' })));
  }
  box.append(h('div', { class: 'actions' },
    h('button', { class: 'button', disabled: ui.busy === agent, onclick: () => doConnect(agent) }, ui.busy === agent ? 'connecting' : 'connect'),
    h('button', { class: 'button is-quiet', onclick: () => { ui.confirm = null; render(); } }, 'cancel')
  ));
  return box;
}

async function doConnect(agent) {
  ui.busy = agent;
  render();
  const result = await api.connect(agent, { replaceStatusLine: ui.replaceStatusLine });
  ui.busy = null;
  if (result && result.ok) {
    ui.confirm = null;
    const notes = [`Connected.`];
    if (result.backups && result.backups.length) notes.push(`Backup: ${result.backups[0].split(/[\\/]/).pop()}.`);
    if (agent === 'codex') notes.push('Now trust the hooks in Codex with /hooks.');
    if (result.statusLine === 'kept-other') notes.push('Your own status line was kept, so Claude\'s limits won\'t arrive.');
    ui.messages[agent] = { ok: true, text: notes.join(' ') };
  } else {
    ui.messages[agent] = { ok: false, text: (result && result.message) || 'Could not connect.' };
  }
  render();
}

async function doDisconnect(agent) {
  const result = await api.disconnect(agent);
  ui.messages[agent] = result && result.ok
    ? { ok: true, text: 'Disconnected. honeybee\'s hooks are gone; everything else is as it was.' }
    : { ok: false, text: (result && result.message) || 'Could not disconnect.' };
  render();
}

// ---- usage ------------------------------------------------------------------------

function comb(leftPercent) {
  const cells = h('div', { class: 'comb', role: 'img', 'aria-label': `${leftPercent}% left` });
  for (let i = 0; i < 10; i += 1) {
    const fill = Math.max(0, Math.min(1, (leftPercent - i * 10) / 10));
    const cell = h('span', { class: 'cell' }, h('i'));
    cell.firstChild.style.height = `${Math.round(fill * 100)}%`;
    cells.append(cell);
  }
  return cells;
}

function windowRow(w, now) {
  const left = w.over ? 'over' : w.reset ? 'full' : `${w.leftPercent}%`;
  return h('div', { class: 'window', dataset: { level: w.level, reset: String(w.reset) } },
    h('span', { class: 'window-label', text: w.label }),
    comb(w.reset ? 100 : w.leftPercent),
    h('span', { class: 'window-left' }, left, w.reset || w.over ? null : h('small', { text: 'left' })),
    h('span', { class: 'window-reset', dataset: { reset: String(w.resetsAt || '') }, text: resetText(w, now) })
  );
}

function providerBlock(agent, data, now) {
  const integ = state.integrations[agent];
  const head = h('div', { class: 'provider-head' },
    h('span', { class: 'provider-name', text: NAMES[agent].toLowerCase() }),
    agent === 'codex' && data && data.plan ? h('span', { class: 'provider-plan', text: `${data.plan} plan` }) : null,
    data ? h('span', { class: 'provider-read', dataset: { read: String(data.observedAt || '') }, text: readText(data.observedAt, now) }) : null
  );
  const block = h('div', { class: 'provider' }, head);
  if (data && data.windows.length) {
    for (const w of data.windows) block.append(windowRow(w, now));
    return block;
  }
  const empty = h('div', { class: 'empty' });
  if (agent === 'claude') {
    if (!integ.connected) {
      empty.append(h('p', { text: 'Connect Claude Code to see its 5-hour and weekly limits.' }));
      if (integ.present) empty.append(h('button', { class: 'button', onclick: () => { settingsOpen = true; ui.confirm = 'claude'; signatures.settings = null; render(); } }, 'connect claude code'));
    } else if (integ.check.statusLine === 'other') {
      empty.append(h('p', { text: 'Your own status line is in place, so Claude Code can\'t pass its limits to honeybee. You can replace it in settings.' }));
    } else {
      empty.append(h('p', { text: 'Waiting for Claude Code. It shares its limits only with sessions in a terminal (the VS Code panel doesn\'t), so they appear after your next reply there. Pro and Max plans only.' }));
    }
  } else if (!integ.present) {
    empty.append(h('p', { text: 'Codex isn\'t set up on this computer.' }));
  } else {
    empty.append(h('p', { text: 'No reading yet. Codex records its limits on every turn, so they show here after your next one.' }));
  }
  block.append(empty);
  return block;
}

function renderUsage() {
  if (!changedSince('usage', state.usage, connections(), localeInUse)) return;
  const now = Date.now();
  document.getElementById('providers').replaceChildren(
    providerBlock('claude', state.usage.claude, now),
    providerBlock('codex', state.usage.codex, now)
  );
}

// ---- status bar -------------------------------------------------------------------

function renderStatusbar() {
  if (!changedSince('status', state.server, state.update, state.version)) return;
  const bar = document.getElementById('statusbar');
  bar.replaceChildren();
  if (state.server.listening) {
    bar.append(h('span', { class: 'dot' }), h('span', { text: `listening on 127.0.0.1:${state.server.port}` }));
  } else {
    bar.append(h('span', { class: 'dot is-off' }), h('span', { class: 'is-error', text: state.server.error || 'not listening' }),
      h('button', { class: 'text-button', onclick: async () => { await api.retryServer(); } }, 'use another port'));
  }
  if (state.update) {
    bar.append(h('button', { class: 'text-button push', onclick: () => api.openExternal(state.update.url) }, `${state.update.version} is out`));
  } else {
    bar.append(h('span', { class: 'push', text: `v${state.version}` }));
  }
}

// ---- settings -----------------------------------------------------------------------

function toggle(key, label) {
  const input = h('input', { type: 'checkbox', onchange: (e) => api.setSetting(key, e.target.checked) });
  input.checked = Boolean(state.settings[key]);
  return h('label', { class: 'toggle' }, input, h('span', { text: label }));
}

function connectionRow(agent) {
  const integ = state.integrations[agent];
  const now = Date.now();
  let text = 'not connected';
  let cls = 'connection-state';
  if (integ.check.error) {
    text = integ.check.error;
    cls += ' is-warn';
  } else if (integ.connected) {
    const seen = integ.hookSeenAt;
    if (seen) text = `connected, last heard ${span(now - seen)} ago`;
    else text = agent === 'codex'
      ? 'connected. Codex runs new hooks only once you trust them: type /hooks in Codex.'
      : 'connected, waiting for the first event';
    cls += seen ? ' is-on' : ' is-warn';
    if (agent === 'claude' && integ.check.statusLine === 'other') {
      text += '. Your own status line is kept, so limits can\'t arrive.';
      cls = 'connection-state is-warn';
    }
    if (integ.check.hooksDisabled) {
      text = agent === 'claude' ? 'hooks are switched off in your Claude Code settings (disableAllHooks)' : 'hooks are switched off in Codex (features.hooks = false)';
      cls = 'connection-state is-warn';
    }
  } else if (integ.check.partial) {
    text = 'some of honeybee\'s hooks were removed. Connect again to put them back.';
    cls += ' is-warn';
  } else if (!integ.present) {
    text = 'not found on this computer';
  } else if (agent === 'codex') {
    text = 'not connected. Sessions still show from Codex\'s logs, without approval alerts.';
  } else if (integ.check.pythonWidget) {
    text = 'not connected. Your old status widget\'s hooks are installed; connecting replaces them.';
  }
  const button = integ.connected
    ? h('button', { class: 'button is-quiet', onclick: () => doDisconnect(agent) }, 'disconnect')
    : h('button', { class: 'button', disabled: !state.server.listening, onclick: () => { ui.confirm = agent; render(); } }, 'connect');
  const stateText = h('span', { class: cls, text });
  // "last heard … ago" keeps itself current through tick().
  if (integ.connected && integ.hookSeenAt && !integ.check.hooksDisabled && !(agent === 'claude' && integ.check.statusLine === 'other')) {
    stateText.dataset.seen = String(integ.hookSeenAt);
  }
  const row = h('div', { class: 'connection' },
    h('span', { class: 'connection-name', text: NAMES[agent].toLowerCase() }),
    stateText,
    button);
  const wrap = h('div', {}, row);
  if (ui.confirm === agent && !integ.connected) wrap.append(confirmBox(agent));
  if (agent === 'claude' && integ.connected && integ.check.statusLine === 'other') {
    wrap.append(h('button', { class: 'button is-quiet', onclick: async () => {
      const result = await api.connect('claude', { replaceStatusLine: true });
      ui.messages.claude = result.ok ? { ok: true, text: 'Status line replaced. Yours comes back when you disconnect.' } : { ok: false, text: result.message };
      render();
    } }, 'replace my status line'));
  }
  if (ui.messages[agent]) wrap.append(h('p', { class: `message ${ui.messages[agent].ok ? 'is-ok' : 'is-error'}`, text: ui.messages[agent].text }));
  return wrap;
}

function renderSettings() {
  if (!changedSince('settings', state.settings, connections(), state.server, state.update, state.version, ui)) return;
  const body = document.getElementById('settings-body');
  const theme = state.settings.theme;
  const segment = (value) => h('button', { 'aria-pressed': String(theme === value), onclick: () => api.setSetting('theme', value) }, value);
  body.replaceChildren(
    h('div', { class: 'group' }, h('h3', { text: 'connections' }), connectionRow('claude'), connectionRow('codex')),
    h('div', { class: 'group' }, h('h3', { text: 'alerts' }),
      toggle('notifyNeedsYou', 'when an agent needs you'),
      toggle('notifyDone', 'when an agent finishes'),
      toggle('notifySound', 'play the system sound')),
    h('div', { class: 'group' }, h('h3', { text: 'window' }),
      toggle('bubbleOnClose', 'fold into a bubble when closed'),
      toggle('alwaysOnTop', 'keep on top of other windows'),
      toggle('launchAtLogin', 'start when you log in')),
    h('div', { class: 'group' }, h('h3', { text: 'theme' }), h('div', { class: 'segments' }, segment('system'), segment('dark'), segment('light'))),
    h('div', { class: 'group about' }, h('h3', { text: 'about' }),
      h('p', { text: `honeybee ${state.version}. Everything stays on this computer: honeybee reads your agents' own files and hears their hooks on 127.0.0.1:${state.server.port}. It never signs in to anything.` }),
      h('div', { class: 'links' },
        h('button', { class: 'text-button', onclick: async () => {
          const r = await api.checkUpdate();
          ui.messages.update = r && r.ok ? { ok: true, text: r.update ? `${r.update.version} is out.` : 'You have the latest version.' } : { ok: false, text: (r && r.message) || 'Could not check.' };
          render();
        } }, 'check for updates'),
        h('button', { class: 'text-button', onclick: () => api.openExternal('https://github.com/banuca/honeybee') }, 'github')),
      ui.messages.update ? h('p', { class: `message ${ui.messages.update.ok ? 'is-ok' : 'is-error'}`, text: ui.messages.update.text }) : null)
  );
}

// ---- live clocks ------------------------------------------------------------------

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let phase = 0;

function tick() {
  if (document.hidden || !state) return;
  const now = Date.now();
  if (!reducedMotion.matches) {
    phase = (phase + 1) % 6;
    for (const g of document.querySelectorAll('.glyph[data-g="working"]')) g.dataset.phase = String(phase);
  }
  for (const node of document.querySelectorAll('.when[data-since]')) {
    const row = node.closest('.session');
    const s = state.agents.find((x) => x.key === row.dataset.key);
    if (s) node.textContent = sinceText(s, now);
  }
  for (const node of document.querySelectorAll('.provider-read[data-read]')) {
    node.textContent = readText(Number(node.dataset.read), now);
  }
  for (const node of document.querySelectorAll('.window-reset[data-reset]')) {
    const resetsAt = Number(node.dataset.reset);
    if (!resetsAt) continue;
    const w = { resetsAt, reset: now >= resetsAt };
    node.textContent = resetText(w, now);
  }
  for (const node of document.querySelectorAll('.connection-state[data-seen]')) {
    const agent = node.closest('.connection').querySelector('.connection-name').textContent === 'codex' ? 'codex' : 'claude';
    const seen = state.integrations[agent].hookSeenAt || Number(node.dataset.seen);
    node.textContent = `connected, last heard ${span(now - seen)} ago`;
  }
}

// ---- events ---------------------------------------------------------------------------

root.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (tab) {
    api.setSetting('view', tab.dataset.tab);
    state.settings.view = tab.dataset.tab;
    render();
    return;
  }
  const action = event.target.closest('[data-action]');
  if (!action) return;
  switch (action.dataset.action) {
    case 'settings': settingsOpen = !settingsOpen; signatures.settings = null; render(); break;
    case 'settings-done': settingsOpen = false; ui.confirm = null; render(); break;
    case 'minimize': api.window('minimize'); break;
    case 'close': api.window('close'); break;
    default: break;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && settingsOpen) {
    settingsOpen = false;
    ui.confirm = null;
    render();
  }
  if ((event.ctrlKey || event.metaKey) && (event.key === '1' || event.key === '2')) {
    const view = event.key === '1' ? 'agents' : 'usage';
    api.setSetting('view', view);
    state.settings.view = view;
    render();
  }
});

api.onState((next) => {
  state = next;
  render();
});
api.getState().then((first) => {
  if (!state) state = first;
  render();
});
setInterval(tick, 1000);
