'use strict';

// What every agent session is doing, built from three kinds of evidence:
//
//   hooks        the agent tells honeybee the moment something happens
//                (exact: prompt sent, approval needed, turn finished)
//   logs         Codex's rollout files, followed as they are written
//   transcripts  Claude Code's transcript, for names and for Esc, which
//                fires no hook at all
//
// Each session is one record keyed by agent and session id. Alerts are raised
// only on a change of status, so the same news arriving by two routes is
// reported once.

const STATUSES = ['needs-you', 'working', 'done', 'stopped', 'failed', 'idle'];

// What needs the user first, then what is moving, then what is settled.
const URGENCY = { 'needs-you': 0, failed: 1, working: 2, done: 3, stopped: 3, idle: 4 };

const DAY = 24 * 3600 * 1000;
const RESTORE_STALE_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 60;
// A session that has gone silent this long was most likely killed or crashed
// without saying goodbye. A long tool run is silent too, so the limit is
// generous, and the next event puts the session straight back.
const QUIET_WORKING_MS = 45 * 60 * 1000;
const QUIET_NEEDS_MS = 6 * 3600 * 1000;

// Events that belong to the whole turn. Inside a subagent these are not the
// session's own, but its tool events (and approvals) are: the session waits
// on them just the same.
const TURN_EVENTS = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Interrupt']);

function oneLine(value, max = 80) {
  if (typeof value !== 'string') return null;
  const text = value.split(/\s+/).filter(Boolean).join(' ');
  return text ? text.slice(0, max) : null;
}

// Plain words for what an approval is for.
function toolLabel(name) {
  const n = String(name || '');
  if (/^(Bash|PowerShell|shell|exec_command|local_shell|unified_exec)$/i.test(n)) return 'a command';
  if (/^(Edit|Write|MultiEdit|NotebookEdit|apply_patch)$/i.test(n)) return 'a file edit';
  if (/^(WebFetch|WebSearch|web_search)$/i.test(n)) return 'web access';
  const mcp = /^mcp__(.+?)__/.exec(n);
  if (mcp) return `a ${mcp[1].replace(/^plugin_/, '').replace(/_/g, ' ')} tool`;
  return n ? n.replace(/_/g, ' ') : 'a tool';
}

const FAILURE_REASONS = {
  rate_limit: 'usage limit reached',
  overloaded: 'service overloaded',
  authentication_failed: 'signed out',
  oauth_org_not_allowed: 'organisation not allowed',
  account_on_hold: 'account on hold',
  billing_error: 'billing problem',
  invalid_request: 'request rejected',
  model_not_found: 'model not found',
  server_error: 'server error',
  max_output_tokens: 'reply too long',
  cloud_credential_error: 'cloud credentials failed'
};

function failureReason(p) {
  const raw = p.error_type || (p.error && typeof p.error === 'object' ? p.error.type : p.error) || p.reason;
  return FAILURE_REASONS[raw] || 'stopped with an error';
}

class Agents {
  /**
   * @param {object} opts
   * @param {() => number} [opts.now]
   * @param {() => void} [opts.onChange]          anything visible changed
   * @param {(alert: object) => void} [opts.onAlert]  a status change worth telling the user about
   */
  constructor({ now = Date.now, onChange = () => {}, onAlert = () => {} } = {}) {
    this.now = now;
    this.onChange = onChange;
    this.onAlert = onAlert;
    this.sessions = new Map();
  }

  key(agent, id) {
    return `${agent}:${id}`;
  }

  get(agent, id) {
    return this.sessions.get(this.key(agent, id)) || null;
  }

  ensure(agent, id) {
    const key = this.key(agent, id);
    let s = this.sessions.get(key);
    if (!s) {
      const now = this.now();
      s = {
        key, agent, id,
        status: 'idle', reason: null, statusSince: now, createdAt: now, updatedAt: now,
        lastHookAt: 0,
        title: null, titleSource: null, project: null, cwd: null, transcriptPath: null,
        lastMessage: null, contextPercent: null, model: null,
        pending: [], hidden: false, via: { hooks: false, log: false, transcript: false }
      };
      this.sessions.set(key, s);
    }
    return s;
  }

  /**
   * Move a session to a status, raising an alert when the change is news.
   * `at` is when it happened, for news read from a log after the fact.
   */
  setStatus(s, status, { reason = null, quiet = false, at = null } = {}) {
    const previous = s.status;
    s.reason = reason;
    if (previous === status) {
      // The log shows it began earlier than honeybee had it (saved before a
      // restart that dated it by the restart): the log knows better.
      if (at > 0 && at < s.statusSince) s.statusSince = at;
      return;
    }
    s.status = status;
    s.statusSince = at > 0 ? Math.min(at, this.now()) : this.now();
    if (quiet) return;
    let kind = null;
    if (status === 'needs-you') kind = 'needs-you';
    else if (status === 'done' && (previous === 'working' || previous === 'needs-you')) kind = 'done';
    else if (status === 'failed') kind = 'failed';
    if (kind) {
      this.onAlert({
        kind, key: s.key, agent: s.agent, title: s.title, project: s.project,
        reason: s.reason, lastMessage: s.lastMessage
      });
    }
  }

  needsYou(s, reason, pendingKey) {
    if (pendingKey && !s.pending.includes(pendingKey)) s.pending.push(pendingKey);
    this.setStatus(s, 'needs-you', { reason });
  }

  // A tool finished (or was refused): settle the approval it was waiting on.
  settleTool(s, pendingKey, toolName) {
    if (s.status !== 'needs-you') {
      if (s.status === 'idle' || s.status === 'done' || s.status === 'stopped') this.setStatus(s, 'working', { quiet: true });
      return;
    }
    if (s.pending.length) {
      const byId = pendingKey ? s.pending.indexOf(pendingKey) : -1;
      const byName = toolName ? s.pending.indexOf(`tool:${toolName}`) : -1;
      if (byId < 0 && byName < 0) return; // a parallel tool finished; the approval is still open
      // The same wait can be recorded by id and by name (a question asked
      // through PreToolUse and then PermissionRequest): settle both.
      s.pending = s.pending.filter((k) => k !== pendingKey && k !== `tool:${toolName}`);
    }
    if (!s.pending.length) this.setStatus(s, 'working');
  }

  touch(s, p) {
    s.updatedAt = this.now();
    s.hidden = false;
    if (typeof p.cwd === 'string' && p.cwd) {
      s.cwd = p.cwd;
      if (!s.project) s.project = baseName(p.cwd);
    }
    if (typeof p.transcript_path === 'string' && p.transcript_path) s.transcriptPath = p.transcript_path;
  }

  remove(agent, id) {
    if (this.sessions.delete(this.key(agent, id))) this.onChange();
  }

  /** A Claude Code hook event, exactly as the hook sent it. */
  claudeEvent(p) {
    if (!p || typeof p.session_id !== 'string' || !p.session_id) return;
    const event = p.hook_event_name;
    if (p.agent_id && TURN_EVENTS.has(event)) return;
    if (event === 'SessionEnd') {
      this.remove('claude', p.session_id);
      return;
    }
    const s = this.ensure('claude', p.session_id);
    this.touch(s, p);
    s.via.hooks = true;
    s.lastHookAt = this.now();

    switch (event) {
      case 'SessionStart':
        break;
      case 'UserPromptSubmit':
        s.pending = [];
        s.lastMessage = null;
        if (!s.title && oneLine(p.prompt)) {
          s.title = oneLine(p.prompt);
          s.titleSource = 'prompt';
        }
        this.setStatus(s, 'working');
        break;
      case 'PreToolUse':
        if (p.tool_name === 'AskUserQuestion') this.needsYou(s, 'answer a question', p.tool_use_id || 'tool:AskUserQuestion');
        else if (p.tool_name === 'ExitPlanMode') this.needsYou(s, 'review the plan', p.tool_use_id || 'tool:ExitPlanMode');
        else if (s.status !== 'needs-you' && s.status !== 'working') this.setStatus(s, 'working', { quiet: true });
        break;
      case 'PermissionRequest':
        this.needsYou(s, `approve ${toolLabel(p.tool_name)}`, p.tool_use_id || `tool:${p.tool_name}`);
        break;
      case 'Notification':
        this.claudeNotification(s, p);
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied':
        this.settleTool(s, p.tool_use_id, p.tool_name);
        break;
      case 'Stop':
        s.pending = [];
        s.lastMessage = oneLine(p.last_assistant_message, 140);
        this.setStatus(s, 'done');
        break;
      case 'StopFailure':
        s.pending = [];
        this.setStatus(s, 'failed', { reason: failureReason(p) });
        break;
      default:
        break;
    }
    this.onChange();
  }

  claudeNotification(s, p) {
    switch (p.notification_type) {
      case 'permission_prompt': {
        // PermissionRequest usually got here first with the exact tool.
        const named = /permission to use (\S+)/i.exec(String(p.message || ''));
        const reason = s.status === 'needs-you' && s.reason
          ? s.reason
          : `approve ${named ? toolLabel(named[1]) : 'a tool'}`;
        this.needsYou(s, reason);
        break;
      }
      case 'elicitation_dialog':
      case 'elicitation_url_dialog':
        this.needsYou(s, 'answer a tool prompt', 'elicitation');
        break;
      case 'agent_needs_input':
        this.needsYou(s, 'needs your input');
        break;
      case 'elicitation_complete':
      case 'elicitation_response':
        this.settleTool(s, 'elicitation');
        break;
      case 'idle_prompt':
        // Claude has been waiting at the prompt for a while: it is done.
        if (s.status === 'working') this.setStatus(s, 'done', { quiet: true });
        break;
      case 'agent_completed':
        this.setStatus(s, 'done');
        break;
      default:
        break;
    }
  }

  /** A Codex hook event. */
  codexEvent(p) {
    if (!p || typeof p.session_id !== 'string' || !p.session_id) return;
    const event = p.hook_event_name;
    if (p.agent_id && TURN_EVENTS.has(event)) return;
    if (event === 'SessionEnd') {
      this.remove('codex', p.session_id);
      return;
    }
    const s = this.ensure('codex', p.session_id);
    this.touch(s, p);
    s.via.hooks = true;
    s.lastHookAt = this.now();
    if (typeof p.model === 'string') s.model = p.model;

    switch (event) {
      case 'SessionStart':
        break;
      case 'UserPromptSubmit':
        s.pending = [];
        s.lastMessage = null;
        if (!s.title && oneLine(p.prompt)) {
          s.title = oneLine(p.prompt);
          s.titleSource = 'prompt';
        }
        this.setStatus(s, 'working');
        break;
      case 'PermissionRequest':
        // Codex sends no call id with an approval, so it is matched by tool.
        this.needsYou(s, `approve ${toolLabel(p.tool_name)}`, `tool:${p.tool_name}`);
        break;
      case 'PreToolUse':
        if (s.status !== 'needs-you' && s.status !== 'working') this.setStatus(s, 'working', { quiet: true });
        break;
      case 'PostToolUse':
        this.settleTool(s, null, p.tool_name);
        break;
      case 'Stop':
        s.pending = [];
        s.lastMessage = oneLine(p.last_assistant_message, 140);
        this.setStatus(s, 'done');
        break;
      case 'Interrupt':
        s.pending = [];
        this.setStatus(s, 'stopped');
        break;
      default:
        break;
    }
    this.onChange();
  }

  /** What Codex's own rollout log says about a session. */
  codexLog(info) {
    if (!info || !info.id) return;
    const existed = this.sessions.has(this.key('codex', info.id));
    const s = this.ensure('codex', info.id);
    s.via.log = true;
    if (info.cwd) s.cwd = info.cwd;
    if (info.project) s.project = info.project;
    if (info.title && s.titleSource !== 'log') {
      s.title = info.title;
      s.titleSource = 'log';
    }
    if (info.transcriptPath) s.transcriptPath = info.transcriptPath;
    const last = info.last;
    // A session first met in its log is as old as its latest news there.
    if (!existed) s.statusSince = Math.min(this.now(), (last && last.at) || info.startedAt || this.now());
    if (!last) {
      if (!existed) s.updatedAt = info.startedAt || this.now();
      this.onChange();
      return;
    }
    // A hook already reported something newer than this log line.
    if (last.at && s.lastHookAt && last.at < s.lastHookAt - 1000) {
      this.onChange();
      return;
    }
    s.updatedAt = Math.max(s.updatedAt, last.at || 0);
    const quiet = Boolean(info.initial);
    const at = last.at;
    if (last.kind === 'started') {
      if (quiet && last.at && this.now() - last.at > 30 * 60 * 1000) {
        this.setStatus(s, 'idle', { quiet: true, at });
      } else if (s.status !== 'needs-you') {
        this.setStatus(s, 'working', { quiet, at });
      }
    } else if (last.kind === 'complete') {
      s.pending = [];
      if (last.lastMessage) s.lastMessage = last.lastMessage;
      this.setStatus(s, 'done', { quiet, at });
    } else if (last.kind === 'aborted') {
      s.pending = [];
      this.setStatus(s, 'stopped', { quiet: true, at });
    }
    if (!quiet) s.hidden = false;
    this.onChange();
  }

  /** A Claude session found from its transcript before any hook fired. */
  claudeSeed({ sessionId, transcriptPath, mtimeMs, details }) {
    if (!sessionId || this.sessions.has(this.key('claude', sessionId))) return;
    const s = this.ensure('claude', sessionId);
    s.transcriptPath = transcriptPath;
    s.via.transcript = true;
    s.updatedAt = mtimeMs || this.now();
    s.statusSince = s.updatedAt;
    this.applyTranscript(s, details);
    const kind = details && details.lastTurn ? details.lastTurn.kind : null;
    let status = 'idle';
    if (kind === 'final') {
      status = 'done';
      s.lastMessage = details.lastTurn.text || null;
    }
    else if (kind === 'interrupted') status = 'stopped';
    else if (kind && this.now() - (mtimeMs || 0) < 2 * 60 * 1000) status = 'working';
    s.status = status;
    this.onChange();
  }

  applyTranscript(s, details) {
    if (!details) return;
    if (details.title) {
      s.title = details.title;
      s.titleSource = 'transcript';
    }
    if (details.project) s.project = details.project;
    if (details.cwd) s.cwd = details.cwd;
  }

  /** Fresh names from a Claude transcript. */
  claudeDetails(key, details) {
    const s = this.sessions.get(key);
    if (!s || !details) return;
    const before = `${s.title}|${s.project}`;
    this.applyTranscript(s, details);
    if (`${s.title}|${s.project}` !== before) this.onChange();
  }

  /** The end of a Claude transcript changed: catch Esc, which sends no hook. */
  claudeTurn(key, turn) {
    const s = this.sessions.get(key);
    if (!s || !turn) return;
    // The transcript grew: the session is alive.
    s.updatedAt = Math.max(s.updatedAt, this.now());
    if (turn.kind === 'interrupted' && (s.status === 'working' || s.status === 'needs-you')) {
      s.pending = [];
      this.setStatus(s, 'stopped', { quiet: true });
      this.onChange();
    } else if (turn.kind === 'final' && s.status === 'working' && !s.via.hooks) {
      this.setStatus(s, 'done');
      this.onChange();
    }
  }

  /** Context and model from Claude Code's status line feed. */
  claudeContext(sessionId, { contextPercent, model, name }) {
    const s = this.get('claude', sessionId);
    if (!s) return;
    let changed = false;
    if (typeof contextPercent === 'number' && contextPercent !== s.contextPercent) {
      s.contextPercent = contextPercent;
      changed = true;
    }
    if (model && model !== s.model) {
      s.model = model;
      changed = true;
    }
    if (name && s.titleSource !== 'transcript' && name !== s.title) {
      s.title = oneLine(name);
      s.titleSource = 'statusline';
      changed = true;
    }
    if (changed) this.onChange();
  }

  dismiss(key) {
    const s = this.sessions.get(key);
    if (s && !s.hidden) {
      s.hidden = true;
      this.onChange();
    }
  }

  /**
   * Settle sessions that went silent (killed, crashed, closed without a
   * goodbye), forget ones nobody has heard from in a day, keep the list bounded.
   */
  expire() {
    const now = this.now();
    let changed = false;
    for (const [key, s] of this.sessions) {
      if (now - s.updatedAt > DAY) {
        this.sessions.delete(key);
        changed = true;
        continue;
      }
      const silent = now - s.updatedAt;
      if ((s.status === 'working' && silent > QUIET_WORKING_MS) || (s.status === 'needs-you' && silent > QUIET_NEEDS_MS)) {
        s.pending = [];
        this.setStatus(s, 'idle', { quiet: true });
        changed = true;
      }
    }
    if (this.sessions.size > MAX_SESSIONS) {
      const settled = [...this.sessions.values()]
        .filter((s) => s.status !== 'working' && s.status !== 'needs-you')
        .sort((a, b) => a.updatedAt - b.updatedAt);
      while (this.sessions.size > MAX_SESSIONS && settled.length) {
        this.sessions.delete(settled.shift().key);
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  list() {
    return [...this.sessions.values()]
      .filter((s) => !s.hidden)
      .sort((a, b) => (URGENCY[a.status] - URGENCY[b.status]) || (b.statusSince - a.statusSince));
  }

  counts() {
    const counts = { 'needs-you': 0, working: 0, done: 0, stopped: 0, failed: 0, idle: 0, total: 0 };
    for (const s of this.list()) {
      counts[s.status] += 1;
      counts.total += 1;
    }
    return counts;
  }

  serialize() {
    return [...this.sessions.values()].map((s) => ({ ...s, pending: [...s.pending], via: { ...s.via } }));
  }

  /**
   * Bring back the list saved at the last quit. Anything that was mid-turn may
   * have finished while honeybee was closed (its hooks had nobody to tell), so
   * it is shown as idle rather than claimed to still be working.
   */
  restore(saved) {
    if (!Array.isArray(saved)) return;
    const now = this.now();
    for (const raw of saved) {
      if (!raw || typeof raw.key !== 'string' || !STATUSES.includes(raw.status)) continue;
      if (now - (raw.updatedAt || 0) > DAY) continue;
      const s = { ...raw, pending: Array.isArray(raw.pending) ? raw.pending : [], via: raw.via || {} };
      if ((s.status === 'working' || s.status === 'needs-you') && now - s.updatedAt > RESTORE_STALE_MS) {
        s.status = 'idle';
        s.reason = null;
        s.pending = [];
      }
      this.sessions.set(s.key, s);
    }
  }
}

function baseName(p) {
  const trimmed = String(p).replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

module.exports = { Agents, toolLabel, failureReason, URGENCY, STATUSES };
