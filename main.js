const { app, BrowserWindow, ipcMain, Tray, Menu, screen, session, shell, Notification, safeStorage, nativeImage } = require('electron');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const Store = require('electron-store');
const { fetchViaWindow, fetchMultipleViaWindow } = require('./src/fetch-via-window');
const { THRESHOLDS, statusForPercent, computeWorstAccount, createLegacyAccountMigration } = require('./src/account-logic');
const { READ_STATUS, ROW_SLOTS, readPercent, isRowAvailable, hasAnyReading, selectRow } = require('./src/usage-status');
const { fitBoundsToDisplays, isReachable } = require('./src/window-bounds');
const { parseReleaseResponse, releasesUrlFor } = require('./src/version-compare');
const { fetchChatGPTUsageData, validateChatGPTToken, normalizeClaudeUsage, manualUsageData } = require('./src/providers');
const { validateManualEntry } = require('./src/manual-entry');

// Fixed usage status bands: green < 80%, orange 80–95%, red 95%+. The
// thresholds are not user-configurable anymore (v3.0 minimalist design).
const WARN_THRESHOLD = THRESHOLDS.WARN;      // 80
const DANGER_THRESHOLD = THRESHOLDS.DANGER;  // 95

// Status colors shared by the tray badges (and mirrored in the renderer CSS).
const STATUS_COLORS = {
  green:  { r: 34,  g: 197, b: 94  },  // #22c55e
  orange: { r: 245, g: 158, b: 11  },  // #f59e0b
  red:    { r: 239, g: 68,  b: 68  },  // #ef4444
  // No reading at all — deliberately not green, so an unknown value can never
  // be mistaken for a healthy one.
  unknown: { r: 113, g: 113, b: 122 }  // #71717a
};

const GITHUB_OWNER = 'banuca';
const GITHUB_REPO = 'ai-usage-monitor';

// ---------------------------------------------------------------------------
// Configuration health
//
// This block used to delete the user's config file whenever it could not be
// parsed OR could not be read at all, on the theory that anything unfamiliar
// was a v1.7.0 encrypted leftover. A partially-written file, a file held open
// by a backup agent, a permissions problem or simply an unexpected shape all
// took that path, and every account, credential and history sample went with
// it, with no copy left anywhere.
//
// Nothing is deleted now. An unusable file is copied aside (and the copy is
// verified) before a fresh one is written; a file that cannot be read is left
// completely alone and the app runs on an in-memory store for the session.
// Either way the renderer is told, so a degraded boot is visible rather than
// silent. See src/config-recovery.js for the decision matrix.
//
// The path comes from Electron's own path table rather than being rebuilt from
// %APPDATA%/os.homedir(): that is where electron-store puts the file anyway,
// and it means app.setPath('userData', ...) redirects this check too - so an
// isolated test profile is genuinely isolated on every platform, which is what
// previously made the Electron fixtures unsafe to run on Linux and macOS.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const { legacyConfigPath, linuxAutostartDir, linuxDesktopDirs } = require('./src/platform-paths');
const {
  CONFIG_HEALTH,
  RECOVERY_ACTIONS,
  planConfigRecovery,
  recoveryFileName,
  createMemoryStore,
  createResilientStore,
  durableFacetOf
} = require('./src/config-recovery');

const configPath = legacyConfigPath({ userData: app.getPath('userData') });

const configHealth = {
  state: CONFIG_HEALTH.OK,
  reason: null,
  // Where the verified copy of an unusable config was put. Once set, that file
  // exists: it is never removed afterwards, whatever else fails.
  preservedPath: null,
  // Is the file at configPath still the user's original? False once it has
  // been replaced with a fresh empty config.
  activeConfigOriginal: true,
  configPath,
  persistent: true
};

function applyConfigRecovery() {
  let exists = false;
  let raw;
  let readError;
  try {
    exists = fs.existsSync(configPath);
  } catch (err) {
    // Cannot even stat it - treat as present and unreadable, never as absent.
    exists = true;
    readError = err;
  }
  if (exists && !readError) {
    try {
      raw = fs.readFileSync(configPath, 'utf-8');
    } catch (err) {
      readError = err;
    }
  }

  const plan = planConfigRecovery({ exists, raw, readError });

  // Replace the active config without ever truncating it in place: write the
  // replacement beside it and move it over. `fs.writeFileSync` on the live
  // path empties the file first, so a write that fails part-way (a full disk,
  // a quota, an antivirus veto) used to leave a zero-byte file where the
  // user's accounts had been - and the old code then deleted the copy it had
  // just verified, on the way out of the same catch block.
  function replaceWithEmptyConfig() {
    const tempPath = `${configPath}.new`;
    try {
      fs.writeFileSync(tempPath, '{}');
      if (fs.readFileSync(tempPath, 'utf-8') !== '{}') throw new Error('replacement-verify-failed');
      fs.renameSync(tempPath, configPath);
      return { ok: true };
    } catch (err) {
      // Only our own temporary file is removed here. Never the original, and
      // never the preserved copy.
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
      return { ok: false, error: err };
    }
  }

  if (plan.action === RECOVERY_ACTIONS.LEAVE_IN_PLACE) {
    configHealth.state = CONFIG_HEALTH.READ_ONLY;
    configHealth.reason = plan.reason;
    console.error(`[Config] ${configPath} could not be read (${plan.reason}). It has been left exactly as it is; this session will not save changes.`);
    return;
  }

  if (plan.action !== RECOVERY_ACTIONS.PRESERVE_AND_RESET) return;

  if (plan.health === CONFIG_HEALTH.OK) {
    // Zero-byte file: an interrupted write, nothing in it to preserve.
    const replaced = replaceWithEmptyConfig();
    if (replaced.ok) {
      configHealth.activeConfigOriginal = false;
      return;
    }
    configHealth.state = CONFIG_HEALTH.READ_ONLY;
    configHealth.reason = `reset-failed:${replaced.error.code || replaced.error.message}`;
    console.error(`[Config] ${configPath} is empty and could not be replaced (${replaced.error.message}). This session will not save changes.`);
    return;
  }

  const preservedPath = path.join(path.dirname(configPath), recoveryFileName());

  // Step 1: copy the original aside and verify it byte for byte. Until this
  // succeeds, nothing whatsoever is written over the original.
  try {
    fs.copyFileSync(configPath, preservedPath);
    if (!fs.readFileSync(preservedPath).equals(fs.readFileSync(configPath))) {
      throw new Error('preserved-copy-mismatch');
    }
  } catch (err) {
    // The copy failed, so it is the copy - our own file, possibly a partial
    // one - that gets cleaned up. The original is untouched and stays that way.
    try { if (fs.existsSync(preservedPath)) fs.unlinkSync(preservedPath); } catch (_) {}
    configHealth.state = CONFIG_HEALTH.READ_ONLY;
    configHealth.reason = `preserve-failed:${err.code || err.message}`;
    console.error(`[Config] ${configPath} is unusable and could not be copied aside (${err.message}). It has been left untouched; this session will not save changes.`);
    return;
  }

  // Step 2: from here the verified copy is the user's only readable record of
  // their configuration. It is recorded before the replacement is attempted
  // and is never deleted, so a failure below cannot cost them both files.
  configHealth.preservedPath = preservedPath;

  const replaced = replaceWithEmptyConfig();
  if (replaced.ok) {
    configHealth.state = CONFIG_HEALTH.PRESERVED;
    configHealth.reason = plan.reason;
    configHealth.activeConfigOriginal = false;
    console.log(`[Config] ${configPath} was unusable (${plan.reason}). The original is preserved at ${preservedPath}; starting with a fresh configuration.`);
    return;
  }

  // The original is still exactly where it was and a verified copy exists, but
  // the file the app needs is still unusable - so it runs in memory and says
  // both things.
  configHealth.state = CONFIG_HEALTH.RESET_FAILED;
  configHealth.reason = `reset-failed:${replaced.error.code || replaced.error.message}`;
  console.error(`[Config] ${configPath} is unusable (${plan.reason}) and could not be replaced (${replaced.error.message}). Your original file is untouched and a verified copy is at ${preservedPath}; this session will not save changes.`);
}

applyConfigRecovery();

function reportConfigWriteFailure({ operation, key, error }) {
  if (configHealth.state === CONFIG_HEALTH.OK || configHealth.state === CONFIG_HEALTH.PRESERVED) {
    configHealth.state = CONFIG_HEALTH.WRITE_FAILED;
    configHealth.reason = `${operation}-failed:${error.code || error.message}`;
  }
  console.error(`[Config] Could not ${operation} "${key}": ${error.message}. Changes are being kept in memory for this session only.`);
  notifyConfigHealth();
}

// Non-sensitive settings storage (no encryption needed).
function createConfigStore() {
  // Both of these mean "there is no usable config file": READ_ONLY could not
  // be read, RESET_FAILED was read, preserved, and could not be replaced.
  if (configHealth.state === CONFIG_HEALTH.READ_ONLY
      || configHealth.state === CONFIG_HEALTH.RESET_FAILED) {
    configHealth.persistent = false;
    return createMemoryStore({});
  }
  try {
    const real = new Store();
    // Force the first read here so a parse failure surfaces as a handled
    // degraded boot rather than as an exception from whichever handler
    // happened to read first.
    void real.store;
    return createResilientStore(real, reportConfigWriteFailure);
  } catch (err) {
    configHealth.state = CONFIG_HEALTH.READ_ONLY;
    configHealth.reason = `store-open-failed:${err.message}`;
    configHealth.persistent = false;
    console.error(`[Config] electron-store could not open ${configPath} (${err.message}). Running in memory for this session; the file is untouched.`);
    return createMemoryStore({});
  }
}

const store = createConfigStore();

// Credentials never go through `store` directly. The credential store decides
// where a credential may live, refuses to write one the OS will not protect,
// and never deletes ciphertext it merely failed to read. See
// src/credential-store.js.
const { createCredentialStore, CREDENTIAL_MODES } = require('./src/credential-store');
const credentials = createCredentialStore({
  store,
  safeStorage,
  platform: process.platform,
  log: (message) => console.warn(message)
});

function notifyConfigHealth() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('config-health', { ...configHealth });
  }
}

// Debug mode: set DEBUG_LOG=1 env var or pass --debug flag to see verbose logs.
// Regular users will only see critical errors in the console.
const DEBUG = process.env.DEBUG_LOG === '1' || process.argv.includes('--debug');
function debugLog(...args) {
  if (DEBUG) console.log('[Debug]', ...args);
}

const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let mainWindow = null;
let sessionTray = null;  // Tray icon for Session usage
let weeklyTray = null;   // Tray icon for Weekly usage

// Per-account read state, keyed by account id. Drives the tray rollup (worst
// account), the per-account tooltip/menu and the payload the renderer gets.
// In-memory only — rebuilt as each account is polled, no storage migration.
//
//   status         one of READ_STATUS (loading / available / unavailable / stale)
//   data           the payload last handed to the renderer, frozen; null while
//                  loading and when nothing usable has ever been read
//   lastSuccessAt  epoch ms of the last SUCCESSFUL AUTOMATIC read. Never moved
//                  by a failure, a manual override, a fallback, a redraw or a
//                  settings change.
//   lastAttemptAt  epoch ms of the last attempt, successful or not
//   error          message from the last failed attempt, cleared on success
const usageStateByAccount = {};

function usageStateFor(accountId) {
  if (!usageStateByAccount[accountId]) {
    usageStateByAccount[accountId] = {
      status: READ_STATUS.LOADING,
      data: null,
      lastSuccessAt: null,
      lastAttemptAt: null,
      error: null
    };
  }
  return usageStateByAccount[accountId];
}

// { accountId: payload } view for the tray rollup and worst-account selection.
function usageDataByAccount() {
  const map = {};
  for (const accountId of Object.keys(usageStateByAccount)) {
    const data = usageStateByAccount[accountId].data;
    if (data) map[accountId] = data;
  }
  return map;
}

// Provider payloads are read-only once recorded: nothing downstream (tray,
// history, renderer bridge) may mutate a reading while presenting it.
function freezeUsagePayload(payload) {
  const rows = Array.isArray(payload.rows)
    ? payload.rows.map((row) => Object.freeze({ ...row }))
    : [];
  return Object.freeze({ ...payload, rows: Object.freeze(rows) });
}

// A successful read. `automatic: false` marks the user's own manual override,
// which is not a reading of the provider and must not advance lastSuccessAt.
function recordUsageSuccess(accountId, data, { automatic }) {
  const state = usageStateFor(accountId);
  const at = Date.now();
  state.lastAttemptAt = at;
  state.error = null;
  state.status = READ_STATUS.AVAILABLE;
  if (automatic) state.lastSuccessAt = at;
  state.data = freezeUsagePayload({
    ...data,
    status: READ_STATUS.AVAILABLE,
    stale: false,
    error: null,
    lastSuccessAt: state.lastSuccessAt,
    readAt: at
  });
  return state.data;
}

// A manual entry standing in for a failed auto-read. The values are the user's
// own, so they are not stale — but this is not an automatic reading either, so
// lastSuccessAt stays put and the error is kept for the card to show.
function recordUsageFallback(accountId, data, error) {
  const state = usageStateFor(accountId);
  const at = Date.now();
  state.lastAttemptAt = at;
  state.error = errorMessage(error);
  state.status = READ_STATUS.AVAILABLE;
  state.data = freezeUsagePayload({
    ...data,
    fallback: true,
    status: READ_STATUS.AVAILABLE,
    stale: false,
    error: state.error,
    lastSuccessAt: state.lastSuccessAt,
    readAt: at
  });
  return state.data;
}

// A failed read. Keeps whatever useful values were last read — marked stale,
// carrying the timestamp of the success they actually came from — and reports
// the account as unavailable when there is nothing to fall back on.
function recordUsageFailure(accountId, error) {
  const state = usageStateFor(accountId);
  state.lastAttemptAt = Date.now();
  state.error = errorMessage(error);

  const previous = state.data;
  if (previous && hasAnyReading(previous.rows)) {
    state.status = READ_STATUS.STALE;
    state.data = freezeUsagePayload({
      ...previous,
      status: READ_STATUS.STALE,
      stale: true,
      error: state.error,
      lastSuccessAt: state.lastSuccessAt,
      readAt: previous.readAt || null
    });
  } else {
    state.status = READ_STATUS.UNAVAILABLE;
    state.data = freezeUsagePayload({
      provider: (getAccount(accountId) || {}).provider || 'claude',
      source: 'auto',
      status: READ_STATUS.UNAVAILABLE,
      stale: false,
      error: state.error,
      lastSuccessAt: state.lastSuccessAt,
      readAt: null,
      rows: [],
      raw: null
    });
  }
  return state.data;
}

function errorMessage(error) {
  if (!error) return 'ReadFailed';
  return error.message ? String(error.message) : String(error);
}

// v2.0 free-resize model: the user owns the window size (see createMainWindow).
// 640 is the design default width used only for the very first run.
const DEFAULT_WINDOW_WIDTH = 640;
const DEFAULT_WINDOW_HEIGHT = 480;
const MIN_WINDOW_WIDTH = 480;
const MIN_WINDOW_HEIGHT = 150;
let firstRunAutoSize = false; // true only until the renderer's one-time first-paint auto-size call lands
const HISTORY_RETENTION_DAYS = 8;
const CHART_DAYS = 7;
const MAX_HISTORY_SAMPLES = 10000; // Cap total samples to prevent unbounded growth

// One history value: the reading of the row that fills this slot, or null when
// no row fills it. null is a gap in the chart; 0 would be a fabricated sample
// claiming usage fell.
//
// The row is chosen by its semantic key (selectRow), never by position: a
// response carrying only a weekly window must record weekly and leave session
// as a gap, not file the weekly figure under session.
function historyValue(rows, slot, legacySection) {
  if (rows.length) {
    const row = selectRow(rows, slot);
    return isRowAvailable(row) ? row.utilization : null;
  }
  return readPercent(legacySection?.utilization);
}

// Append one history sample. Only a fresh success may create a sample: a
// failed, stale or fallback read must never fabricate one, and existing
// history is left exactly as it is.
function storeUsageHistory(accountId, data) {
  if (!data) return;

  if (data.stale || data.status === READ_STATUS.STALE || data.status === READ_STATUS.UNAVAILABLE) {
    debugLog('[History] Skipping write — reading is stale or unavailable, not a fresh success');
    return;
  }
  if (data.fallback) {
    debugLog('[History] Skipping write — manual fallback for a failed auto-read');
    return;
  }

  // Skip write if the session is invalid — a live auto session always has at
  // least one reset timestamp. Manual entries have no timestamps and are
  // recorded too (they carry source: 'manual').
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (!hasAnyReading(rows) && !readPercent(data.five_hour?.utilization) && !readPercent(data.seven_day?.utilization)) {
    debugLog('[History] Skipping write — response carried no usable reading');
    return;
  }
  const hasResets = rows.some((row) => row.resets_at);
  if (!hasResets && data.source !== 'manual' && !data.five_hour?.resets_at && !data.seven_day?.resets_at) {
    debugLog('[History] Skipping write — no reset timestamps, likely invalid session data');
    return;
  }

  const historyKey = `usageHistory_acct_${accountId}`;

  const timestamp = Date.now();
  let history = store.get(historyKey, []);

  history.push({
    timestamp,
    session: historyValue(rows, ROW_SLOTS.SESSION, data.five_hour),
    weekly: historyValue(rows, ROW_SLOTS.WEEKLY, data.seven_day)
  });

  // Rotation: apply both time-based and count-based limits
  const cutoff = timestamp - (HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  history = history.filter((entry) => entry.timestamp > cutoff);

  if (history.length > MAX_HISTORY_SAMPLES) {
    history = history.slice(history.length - MAX_HISTORY_SAMPLES);
  }

  store.set(historyKey, history);
}

// Migrate legacy single-key history to the per-org namespaced key at startup,
// so get-usage-history reads from the right place before any fetch has run.
function migrateUsageHistoryKey() {
  const organizationId = store.get('organizationId');
  if (!organizationId) return;
  const historyKey = `usageHistory_${organizationId}`;
  if (store.has(historyKey)) return;
  const legacy = store.get('usageHistory', []);
  if (legacy.length > 0) {
    store.set(historyKey, legacy);
    store.delete('usageHistory');
    debugLog('[History] Migrated legacy usageHistory →', historyKey);
  }
}

// One-time migration: rename any pre-multi-account `usageHistory_<orgId>` key to the
// namespaced `usageHistory_acct_<accountId>` key, for whichever account now owns that
// orgId. Keys with no matching account (orphaned orgs) are left for pruneStaleHistoryKeys
// to age out. Must run after migrateLegacyAccount() so accounts[] is populated.
function migrateUsageHistoryKeysToAccounts() {
  const accounts = getAccounts();
  const allKeys = Object.keys(store.store);
  for (const key of allKeys) {
    if (!key.startsWith('usageHistory_') || key.startsWith('usageHistory_acct_')) continue;
    const orgId = key.slice('usageHistory_'.length);
    const account = accounts.find((a) => a.orgId === orgId);
    if (!account) continue; // no matching account — leave for pruneStaleHistoryKeys

    const newKey = `usageHistory_acct_${account.id}`;
    if (!store.has(newKey)) {
      store.set(newKey, store.get(key));
    }
    store.delete(key);
    debugLog('[History] Migrated', key, '→', newKey);
  }
}

// Prune all history keys (old `usageHistory_<orgId>` and new `usageHistory_acct_<id>`
// forms) at startup. Trims entries older than the retention window and deletes the key
// entirely if nothing remains — cleans up abandoned accounts and orphaned orgs.
function pruneStaleHistoryKeys() {
  const cutoff = Date.now() - (HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const allKeys = Object.keys(store.store);
  for (const key of allKeys) {
    if (!key.startsWith('usageHistory_') && key !== 'usageHistory') continue;
    const history = store.get(key, []);
    const fresh = history.filter((entry) => entry.timestamp > cutoff);
    if (fresh.length === 0) {
      store.delete(key);
      debugLog('[History] Deleted stale key:', key);
    } else if (fresh.length < history.length) {
      store.set(key, fresh);
      debugLog('[History] Pruned', history.length - fresh.length, 'old entries from', key);
    }
  }
}

// Set session-level User-Agent to avoid Electron detection
app.on('ready', () => {
  session.defaultSession.setUserAgent(CHROME_USER_AGENT);
});

// ---------------------------------------------------------------------------
// Multi-account model
//
// Each account owns an isolated Electron session partition
// (`persist:acct-<id>`), so its sessionKey cookie lives in its own jar and
// multiple logins coexist. The store holds a list of accounts; the sessionKey
// itself lives in the partition's cookie jar plus an encrypted safeStorage
// backup keyed by account id (re-applied to the partition on startup).
// ---------------------------------------------------------------------------

function partitionFor(id) {
  return `persist:acct-${id}`;
}

// ---------------------------------------------------------------------------
// Account generations
//
// A usage read is a sequence of awaits: set the cookie, open a hidden window,
// navigate, run a script, come back. The account it started for can be removed
// or re-authenticated in the meantime, and the old code captured the account
// object up front and then wrote state, history and (worst) credential
// deletions against it regardless.
//
// Every mutation that changes what an account IS bumps its generation.
// A read carries the generation it started with and abandons itself the moment
// that no longer matches, so a late result cannot recreate a removed account's
// data or delete a credential that was saved after it started.
// ---------------------------------------------------------------------------
const accountGenerations = new Map();

function accountGenerationOf(id) {
  return accountGenerations.get(String(id)) || 0;
}

function bumpAccountGeneration(id) {
  const key = String(id);
  const next = accountGenerationOf(key) + 1;
  accountGenerations.set(key, next);
  return next;
}

// Is the read that started at `generation` still about the same account?
//
// "Current" now also means "nobody is changing this account right now". A read
// that overlaps a save is looking at an account that is mid-replacement: its
// generation matches only because the save has not committed yet, and acting
// on it is exactly how a provider rejection for the OLD credential came to
// delete the NEW one. Such a read abandons itself instead.
function isAccountCurrent(id, generation) {
  return !!getAccount(id)
    && accountGenerationOf(id) === generation
    && !hasPendingAccountOperation(id);
}

// ---------------------------------------------------------------------------
// Per-account operations
//
// Ownership of an account MUTATION is a different problem from staleness of a
// READ, and the two used to be answered by the same counter plus a `saveClaim`
// marker written into the account row. That had three consequences the
// correction review reproduced:
//
//   - a reservation marker stored as account DATA made a committed account
//     look like a disposable draft, so cancelling a draft could delete a saved
//     account's credential during a reconnect;
//   - a save mutated the durable credential before its cookie write with no
//     way back, so a failed cookie write left the replacement in place and the
//     previous credential gone;
//   - removal cleared the partition without waiting for cookie writes that
//     were already in flight, so a completed removal could be followed by the
//     account's login cookie being written back.
//
// The model here replaces all three. Every mutation of an account - save,
// removal, draft discard - is an OPERATION held in memory for as long as it
// runs and never written to disk. Starting one supersedes every operation that
// is still running for the same account, so "who owns this account right now"
// is answered by object identity rather than by comparing a marker that a
// restart, a rollback or a partial write could leave behind.
//
// Separately, every cookie write for an account registers itself here,
// including the ones that belong to no login flow at all (a refresh poll
// re-asserting the credential on its partition). Removal seals the account
// against new writes, drains the ones already in flight, and only then wipes
// the partition - which is what makes "removed" mean removed.
// ---------------------------------------------------------------------------
const accountOpsById = new Map();

function accountOpsFor(id) {
  const key = String(id);
  let entry = accountOpsById.get(key);
  if (!entry) {
    entry = { seq: 0, active: new Set(), writers: new Set(), sealed: false, removing: false, removed: false };
    accountOpsById.set(key, entry);
  }
  return entry;
}

// Is some mutation of this account in flight? Reads consult this; so does the
// renderer-facing account list, which must not show a half-applied reconnect.
function hasPendingAccountOperation(id) {
  const entry = accountOpsById.get(String(id));
  return !!entry && entry.active.size > 0;
}

/**
 * Begin a mutation of one account, superseding any that are still running.
 *
 * `kind` is 'save' | 'remove' | 'discard'. `draft` records the identity the
 * operation started with: a save for an id that has no committed account row
 * is a DRAFT and may be discarded; a save for an existing account is a
 * RECONNECT and may not, whatever happens to the row while it runs. That
 * decision is taken once, here, and never re-derived from the row afterwards.
 */
function beginAccountOperation(id, kind, { draft = false } = {}) {
  const entry = accountOpsFor(id);
  entry.seq += 1;
  const op = { id: String(id), kind, draft, seq: entry.seq, cancelled: false, cancelledBy: null, entry };
  for (const older of entry.active) {
    older.cancelled = true;
    older.cancelledBy = kind;
  }
  entry.active.add(op);
  return op;
}

function endAccountOperation(op) {
  if (op) op.entry.active.delete(op);
}

// Does this operation still own its account, or has something newer taken it?
function accountOperationLives(op) {
  return !!op && !op.cancelled;
}

// Cancel any in-flight DRAFT save for this id. A reconnect is never cancelled
// this way: it belongs to an account that already exists.
function cancelDraftOperations(id, by) {
  const entry = accountOpsById.get(String(id));
  if (!entry) return 0;
  let cancelled = 0;
  for (const op of entry.active) {
    if (op.kind === 'save' && op.draft) {
      op.cancelled = true;
      op.cancelledBy = by;
      cancelled += 1;
    }
  }
  return cancelled;
}

// Register a cookie write so removal and cancellation can wait for it. Every
// writer goes through here, not only the ones inside a login flow.
function trackAccountWrite(id, promise) {
  const entry = accountOpsFor(id);
  entry.writers.add(promise);
  const done = () => entry.writers.delete(promise);
  promise.then(done, done);
  return promise;
}

// Wait until this account has no cookie write outstanding. Settling one writer
// can start another (a poll that was queued behind it), so this loops rather
// than awaiting one snapshot of the set. It reports whether the set really did
// empty: a drain that gave up is a fact the caller has to tell the user.
async function drainAccountWrites(id, rounds = 25) {
  const entry = accountOpsFor(id);
  for (let round = 0; round < rounds && entry.writers.size; round += 1) {
    await Promise.allSettled([...entry.writers]);
  }
  return entry.writers.size === 0;
}

// Seal/unseal an account's partition against new cookie writes.
function sealAccount(id, sealed) {
  accountOpsFor(id).sealed = sealed;
}

function isAccountSealed(id) {
  const entry = accountOpsById.get(String(id));
  return !!entry && entry.sealed;
}

// Thrown by a read that discovered it no longer owns its account. The renderer
// treats it as "nothing to do" rather than as a failure, because there is no
// account left to report a failure for.
const STALE_READ = 'StaleRead';

// Resolve an account's partition session and ensure it carries the spoofed
// Chrome UA (Claude/Cloudflare blocks Electron's default UA).
function getAccountSession(id) {
  const s = session.fromPartition(partitionFor(id));
  s.setUserAgent(CHROME_USER_AGENT);
  return s;
}

function getAccounts() {
  return store.get('accounts', []);
}

/**
 * Write the account list, and say whether it reached the configuration file.
 *
 * The resilient store deliberately keeps a rejected write in memory so the app
 * stays usable, which is right for settings and wrong for anything the user is
 * told is done. Removal in particular must not report success when the account
 * will be back at the next launch, so this attempts the DURABLE write first and
 * only falls back to the session overlay - reporting `persisted: false`.
 *
 * @returns {{persisted: boolean, reason?: string}}
 */
function setAccounts(accounts) {
  const durable = durableFacetOf(store);
  if (!durable) {
    store.set('accounts', accounts);
    return { persisted: false, reason: 'config-not-durable' };
  }
  try {
    durable.set('accounts', accounts);
    return { persisted: true };
  } catch (err) {
    store.set('accounts', accounts);
    return { persisted: false, reason: err.code || err.message };
  }
}

/**
 * Delete one key from the configuration file and say whether the FILE lost it.
 *
 * `store.delete` alone is not enough for anything the user is told is deleted:
 * the resilient wrapper answers a rejected delete by tombstoning the key in a
 * session overlay, so the key looks gone for this run and is back at the next
 * launch. This tries the durable facet first and reports the truth, while
 * still tombstoning in the overlay so the running app behaves as asked.
 *
 * @returns {{removed: boolean, reason?: string}}
 */
function deleteDurableKey(key) {
  const durable = durableFacetOf(store);
  const hideInSession = () => {
    try { store.delete(key); } catch (err) { debugLog(`[Config] Session delete of ${key} failed: ${err.message}`); }
  };
  if (!durable) {
    hideInSession();
    return { removed: false, reason: 'config-not-durable' };
  }
  try {
    durable.delete(key);
    hideInSession();
    return { removed: true };
  } catch (err) {
    hideInSession();
    return { removed: false, reason: err.code || err.message };
  }
}

/**
 * Boot-time tidy-up for `saveClaim` markers left by an older build.
 *
 * Nothing written by this version ever puts a claim in the account list -
 * ownership of a save is an in-memory operation now. But a profile written by
 * the previous build can still hold one, and simply deleting the marker was
 * wrong: it PROMOTED an interrupted reservation to a committed account.
 *
 * The marker means "a save reserved this row and never committed it". The old
 * save wrote the credential before reserving the row, so the two cases are
 * distinguishable on disk:
 *
 *   - a credential exists for the id -> the save got as far as storing a
 *     credential; the row is real enough to keep, and the marker goes;
 *   - no credential exists -> the save never got that far, and the row is a
 *     reservation that was never an account. It is dropped rather than
 *     presented as a connected account that has nothing to connect with.
 */
function clearStaleSaveClaims() {
  const accounts = getAccounts();
  if (!accounts.some((a) => a && a.saveClaim)) return;
  const kept = [];
  const dropped = [];
  for (const account of accounts) {
    if (!account || !account.saveClaim) {
      kept.push(account);
      continue;
    }
    let hasCredential = false;
    try {
      hasCredential = credentials.credentialState(account.id).persisted === true;
    } catch (err) {
      // Unreadable is not absent: keep the row rather than delete an account
      // because the keychain was busy at startup.
      hasCredential = true;
      debugLog(`[Account] Could not inspect the credential for ${account.id} while clearing a stale claim: ${err.message}`);
    }
    if (hasCredential) {
      delete account.saveClaim;
      kept.push(account);
    } else {
      dropped.push(account.id);
    }
  }
  setAccounts(kept);
  debugLog(`[Account] Cleared save claims left behind by an interrupted save (kept ${kept.length}, dropped ${dropped.length ? dropped.join(',') : 'none'})`);
  if (dropped.length) {
    console.warn(`[Account] Dropped ${dropped.length} account row(s) reserved by an interrupted save that never stored a credential: ${dropped.join(', ')}`);
  }
}

function getAccount(id) {
  return getAccounts().find((a) => a.id === id);
}

// Authentication work is scoped to the renderer flow that started it. This
// lets cancellation abort hidden validation windows and wait for their cookie
// writes to settle before a reconnect credential is restored (or a new draft
// is discarded). A later flow on the same partition replaces the old state.
const authFlowsByPartition = new Map();

function beginAuthFlow(partition, flowId) {
  if (!partition || flowId === undefined || flowId === null) return null;
  const current = authFlowsByPartition.get(partition);
  if (current && current.flowId === flowId) return current;
  const state = { flowId, cancelled: false, controller: new AbortController(), pending: new Set() };
  authFlowsByPartition.set(partition, state);
  return state;
}

function isAuthFlowActive(partition, state) {
  return !state || (authFlowsByPartition.get(partition) === state && !state.cancelled);
}

function trackAuthOperation(state, operation) {
  const promise = Promise.resolve().then(operation);
  if (!state) return promise;
  state.pending.add(promise);
  const remove = () => state.pending.delete(promise);
  promise.then(remove, remove);
  return promise;
}

async function restoreSavedCredential(partition) {
  if (!partition || !partition.startsWith('persist:acct-')) return;
  const id = partition.slice('persist:acct-'.length);
  const account = getAccount(id);
  const key = account && loadAccountKey(id);
  if (!key) return;
  try {
    await setSessionCookie(key, id, account.provider);
  } catch (err) {
    // A sealed account is one a removal owns. Restoring its credential is
    // exactly what must not happen, and it is not an error the caller can act
    // on: the account is going away.
    if (err && err.message === STALE_READ) {
      debugLog(`[Account] Not restoring a credential for account ${id}: it is being removed`);
      return;
    }
    throw err;
  }
}

function finishAuthFlow(partition, flowId) {
  if (flowId === undefined || flowId === null) return;
  const state = authFlowsByPartition.get(partition);
  if (state && state.flowId === flowId) authFlowsByPartition.delete(partition);
}

// Monotonic account id so partitions stay stable and readable (acct-1, acct-2…).
function nextAccountId() {
  const n = store.get('accountSeq', 0) + 1;
  store.set('accountSeq', n);
  return String(n);
}

// Default labels: first account "Personal", second "Work", then "Account N".
function defaultLabel(index) {
  if (index === 0) return 'Personal';
  if (index === 1) return 'Work';
  return `Account ${index + 1}`;
}

// Per-account credential storage. Three behaviours worth stating, all of them
// in src/credential-store.js:
//
//   - a credential is persisted ONLY when the OS will actually protect it, so
//     nothing is written to config.json in the clear any more (Linux's
//     basic_text backend counts as unprotected);
//   - reading looks in every location rather than in whichever one current
//     availability suggests, so a credential never becomes invisible because
//     the keychain state changed;
//   - a credential that cannot be decrypted right now is reported as locked
//     and left exactly where it is.
function saveAccountKey(id, sessionKey) {
  return credentials.save(id, sessionKey);
}

// The plain key, or null. Callers that need to tell "no credential" from
// "locked keychain" apart use loadAccountCredential instead.
function loadAccountKey(id) {
  return credentials.load(id).key;
}

function loadAccountCredential(id) {
  return credentials.load(id);
}

// Returns the credential store's report: { removed, failures }. A caller that
// tells the user an account is gone has to know whether it really is.
function deleteAccountKey(id) {
  return credentials.remove(id);
}

// Is this account's credential unusable because of the keychain rather than
// because it is missing? Reconnecting cannot repair either of these.
function isKeychainProblem(mode) {
  return mode === CREDENTIAL_MODES.LOCKED || mode === CREDENTIAL_MODES.UNDECRYPTABLE
    || mode === CREDENTIAL_MODES.UNREADABLE;
}

/**
 * May a provider login happen at all right now?
 *
 * Checking this only when the credential is finally saved was not enough. Every
 * login and validation path writes the provider's auth cookie into the
 * account's PERSISTENT Chromium partition first — a file on disk, in the user's
 * profile, holding the same secret. On a host where the OS will not protect a
 * credential (no keychain, or Linux's basic_text backend, which is obfuscation
 * with a hard-coded key), that write is the very exposure the save refuses.
 *
 * So the gate sits in front of the login window and the validators too, and the
 * renderer offers the manual-only route instead. There is deliberately no
 * temporary/session login: it would mean writing the secret into the partition
 * anyway and losing it at exit.
 *
 * @returns {{allowed: boolean, security?: Object, error?: string}}
 */
function checkLoginAllowed() {
  if (!credentials.isDurable()) {
    return {
      allowed: false,
      error: 'Your settings file could not be opened, so a sign-in cannot be saved. Enter your usage manually instead.',
      reason: 'config-not-durable',
      security: credentials.security()
    };
  }
  const security = credentials.security();
  if (!security.secure) {
    return {
      allowed: false,
      error: 'This computer cannot protect a saved sign-in, so signing in is not offered. Enter your usage manually instead.',
      reason: security.reason,
      security
    };
  }
  return { allowed: true, security };
}

// Cookie names per provider — the credential each provider authenticates with.
const PROVIDER_COOKIES = {
  claude: { name: 'sessionKey', domain: '.claude.ai', url: 'https://claude.ai' },
  chatgpt: { name: '__Secure-next-auth.session-token', domain: '.chatgpt.com', url: 'https://chatgpt.com' }
};

// Set the provider's auth cookie on an account's partition session. Claude
// uses its sessionKey cookie; ChatGPT uses its next-auth session token. Both
// ride the account's own partition so multiple logins coexist.
async function setSessionCookie(sessionKey, id, provider) {
  // A sealed account is one whose partition is being wiped. Refusing here is
  // the half of the fix that stops a LATER writer sneaking a credential back
  // into a partition a removal has already reported clean; draining the
  // writers that were already in flight is the other half, and lives in the
  // removal handler.
  if (isAccountSealed(id)) {
    debugLog(`[Account] Refused a cookie write for account ${id}: its partition is being cleared`);
    throw new Error(STALE_READ);
  }
  const resolvedProvider = provider || getAccount(id)?.provider || 'claude';
  const spec = PROVIDER_COOKIES[resolvedProvider] || PROVIDER_COOKIES.claude;
  const sess = getAccountSession(id);
  // Two registers, deliberately.
  //
  // The login flow's pending set scopes a write to the renderer flow that
  // started it, so cancelling that flow waits for its own work. But MOST
  // cookie writes belong to no flow at all - every refresh poll re-asserts the
  // credential on the partition before reading - and those were invisible to
  // cancellation and to removal. The per-account writer set catches all of
  // them, flow or no flow.
  const flow = authFlowsByPartition.get(partitionFor(id));
  const write = trackAuthOperation(flow, () => sess.cookies.set({
    url: spec.url,
    name: spec.name,
    value: sessionKey,
    domain: spec.domain,
    path: '/',
    secure: true,
    httpOnly: true
  }));
  trackAccountWrite(id, write);
  await write;
  debugLog(`${spec.name} cookie set on partition for account ${id} (${resolvedProvider})`);
}

// One-time migration: fold a pre-existing single-account config into accounts[0].
// Runs before the first render so the widget shows the account straight away.
// Boot-time tidy-up: no save owns a claim across a restart.
clearStaleSaveClaims();

function migrateLegacyAccount() {
  if (store.get('accounts') !== undefined) return; // already on the multi-account model

  let legacyKey = null;
  // If a legacy credential exists but cannot be opened right now, this
  // migration does not run at all: it would otherwise conclude "nothing to
  // migrate", write an empty accounts list (which marks the migration
  // permanently done) and then delete the encrypted key it could not read.
  // Skipping leaves every byte in place and retries on the next launch.
  let legacyLocked = false;
  const legacyEncrypted = store.get('sessionKey_encrypted');
  if (legacyEncrypted) {
    const security = credentials.security();
    if (!security.available) {
      legacyLocked = true;
      console.warn(`[Migration] A legacy credential exists but secure storage is unavailable (${security.reason}) — migration deferred, nothing changed`);
    } else {
      try {
        legacyKey = safeStorage.decryptString(Buffer.from(legacyEncrypted, 'base64'));
      } catch (err) {
        legacyLocked = true;
        console.error('[Migration] Legacy session key could not be decrypted — migration deferred, nothing changed:', err.message);
      }
    }
  }
  if (legacyLocked) return;
  if (!legacyKey) legacyKey = store.get('sessionKey', null);
  const legacyOrg = store.get('organizationId', null);

  const migration = createLegacyAccountMigration({
    legacyKey,
    legacyOrg,
    id: legacyKey && legacyOrg ? nextAccountId() : null
  });

  if (migration.sessionKeyByAccount) {
    saveAccountKey(migration.sessionKeyByAccount.id, migration.sessionKeyByAccount.sessionKey);
    debugLog('[Migration] Migrated legacy single account into accounts[0], id', migration.sessionKeyByAccount.id);
  } else {
    // Nothing to migrate — initialise an empty list so this never runs again.
  }
  setAccounts(migration.accounts);

  // Clear legacy single-account keys regardless (their data now lives per-account).
  if (migration.clearLegacyKeys) {
    store.delete('sessionKey');
    store.delete('sessionKey_encrypted');
    store.delete('organizationId');
  }
}

// Load persisted window bounds, migrating the old position-only `windowPosition`
// key (pre-2.0, before the window was freely resizable) into the new
// {x,y,width,height} shape. Returns null on a true first run — the caller then
// auto-sizes to content on first paint (see set-window-bounds's firstRunAutoSize
// handling below).
function loadWindowBounds() {
  const bounds = store.get('windowBounds');
  if (bounds) return bounds;

  const legacyPosition = store.get('windowPosition');
  if (legacyPosition) {
    const migrated = { x: legacyPosition.x, y: legacyPosition.y, width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT };
    store.set('windowBounds', migrated);
    store.delete('windowPosition');
    return migrated;
  }

  return null;
}

// The display list in the shape src/window-bounds.js expects.
function currentDisplays() {
  try {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d) => ({
      id: d.id,
      bounds: d.bounds,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
      primary: d.id === primaryId
    }));
  } catch (err) {
    // Called before the screen module is usable, or on a headless machine.
    debugLog('[Window] Display information unavailable:', err.message);
    return [];
  }
}

// Saved bounds are a preference, not an instruction. A monitor that has been
// unplugged, rearranged or rescaled since the last run leaves coordinates
// pointing at nothing, and with the tray off by default an off-screen window
// is unrecoverable. See src/window-bounds.js.
function fittedStartupBounds() {
  const saved = loadWindowBounds();
  if (!saved) return null;
  const fitted = fitBoundsToDisplays(saved, currentDisplays(), {
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT
  });
  if (fitted.changed) {
    console.log(`[Window] Saved bounds ${JSON.stringify(saved)} did not fit the current displays `
      + `(${fitted.reason}); using ${JSON.stringify(fitted.bounds)}`);
  }
  return fitted.bounds;
}

// ── Appearance ────────────────────────────────────────────────────────────
//
// Two themes, both taken from Microsoft's own VS Code defaults: Dark Modern
// (the widget's original look) and Light Modern. The value is a stored
// setting, and it is ALSO handed to the renderer as a command-line argument so
// the first paint is already in the right theme - reading it over IPC would
// paint the dark palette first and then swap, which on a small always-on-top
// window is a visible flash.
const THEMES = ['dark', 'light'];
const DEFAULT_THEME = 'dark';

function normaliseTheme(value) {
  return THEMES.includes(value) ? value : DEFAULT_THEME;
}

function storedTheme() {
  return normaliseTheme(store.get('settings.theme', DEFAULT_THEME));
}

function createMainWindow() {
  const savedBounds = fittedStartupBounds();
  firstRunAutoSize = !savedBounds;

  const windowOptions = {
    width: savedBounds ? savedBounds.width : DEFAULT_WINDOW_WIDTH,
    height: savedBounds ? savedBounds.height : DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    // Transparent windows don't support native OS edge-resize (Electron docs), and
    // flipping `resizable: true` risks breaking transparency on some platforms —
    // so this stays false. The renderer drives resizing itself with pointer-driven
    // grips that call setBounds() over the set-window-bounds IPC handler below,
    // which works regardless of this flag.
    resizable: false,
    skipTaskbar: false,
    icon: path.join(__dirname, process.platform === 'darwin' ? 'assets/icon.icns' : process.platform === 'linux' ? 'assets/icons/512x512.png' : 'assets/icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // Read by preload and applied to <html> before the stylesheet paints.
      additionalArguments: [`--widget-theme=${storedTheme()}`]
    }
  };

  if (savedBounds) {
    windowOptions.x = savedBounds.x;
    windowOptions.y = savedBounds.y;
  }

  mainWindow = new BrowserWindow(windowOptions);
  // Absolute path: loadFile resolves relative paths against the app entry
  // directory, which differs when main.js is loaded from a smoke/test entry.
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  // Belt-and-braces for X11 window managers that don't pick up the
  // BrowserWindow `icon` option reliably (see ensureLinuxDesktopIntegration).
  if (process.platform === 'linux') {
    mainWindow.setIcon(nativeImage.createFromPath(path.join(__dirname, 'assets/icons/512x512.png')));
  }

  let boundsSaveTimer = null;
  const scheduleBoundsSave = () => {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      store.set('windowBounds', mainWindow.getBounds());
    }, 300);
  };
  mainWindow.on('move', scheduleBoundsSave);
  mainWindow.on('resize', scheduleBoundsSave);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // A monitor unplugged (or rescaled) while the app is open strands the window
  // just as effectively as one unplugged between runs.
  const refitToDisplays = (why) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const displays = currentDisplays();
    const current = mainWindow.getBounds();
    if (isReachable(current, displays)) return;
    const fitted = fitBoundsToDisplays(current, displays, {
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT
    });
    if (!fitted.bounds) return;
    console.log(`[Window] ${why}: the window was left off-screen at ${JSON.stringify(current)}; `
      + `moving it to ${JSON.stringify(fitted.bounds)}`);
    mainWindow.setBounds(fitted.bounds);
    store.set('windowBounds', mainWindow.getBounds());
  };
  const onDisplayRemoved = () => refitToDisplays('display removed');
  const onDisplayMetrics = () => refitToDisplays('display metrics changed');
  screen.on('display-removed', onDisplayRemoved);
  screen.on('display-metrics-changed', onDisplayMetrics);
  mainWindow.once('closed', () => {
    screen.removeListener('display-removed', onDisplayRemoved);
    screen.removeListener('display-metrics-changed', onDisplayMetrics);
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

/**
 * Status color for a usage percentage: green < 80, orange 80–95, red ≥ 95.
 * Used by the tray badges — one color scheme everywhere.
 */
function statusColorFor(percent) {
  return STATUS_COLORS[statusForPercent(percent)] || STATUS_COLORS.green;
}

/**
 * Bold 8x11 bitmap font for numbers 0-9 (2-pixel strokes for bold look)
 * Each number is represented as an array of 11 rows, each row is 8 bits
 */
const BITMAP_FONT = {
  '0': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '1': [
    0b00011000,
    0b00111000,
    0b01111000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b01111110,
    0b01111110
  ],
  '2': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b00000011,
    0b00000110,
    0b00011100,
    0b00111000,
    0b01110000,
    0b11100000,
    0b11111111,
    0b11111111
  ],
  '3': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b00000011,
    0b00000110,
    0b00111100,
    0b00000110,
    0b00000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '4': [
    0b00000110,
    0b00001110,
    0b00011110,
    0b00110110,
    0b01100110,
    0b11111111,
    0b11111111,
    0b00000110,
    0b00000110,
    0b00000110,
    0b00000110
  ],
  '5': [
    0b11111111,
    0b11111111,
    0b11000000,
    0b11000000,
    0b11111100,
    0b00000110,
    0b00000011,
    0b00000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '6': [
    0b00111100,
    0b01111110,
    0b11100000,
    0b11000000,
    0b11111100,
    0b11100110,
    0b11000011,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '7': [
    0b11111111,
    0b11111111,
    0b00000011,
    0b00000110,
    0b00001100,
    0b00011000,
    0b00110000,
    0b00110000,
    0b01100000,
    0b01100000,
    0b01100000
  ],
  '8': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b01111110,
    0b00111100,
    0b01111110,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '9': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b11000011,
    0b01111111,
    0b00111111,
    0b00000011,
    0b00000111,
    0b01111110,
    0b00111100
  ]
};

/**
 * Narrow 6x11 bitmap font for 3-digit numbers (100%)
 * Bold version to match
 */
const BITMAP_FONT_NARROW = {
  '0': [
    0b011110,
    0b111111,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b111111,
    0b011110
  ],
  '1': [
    0b001100,
    0b011100,
    0b111100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b111111,
    0b111111
  ]
};

/**
 * Draw a crisp bitmap character at position (x, y) in the buffer
 */
function drawChar(buffer, width, height, char, x, y, color, useNarrow = false) {
  const bitmap = useNarrow ? BITMAP_FONT_NARROW[char] : BITMAP_FONT[char];
  if (!bitmap) return useNarrow ? 6 : 8;
  
  const charWidth = useNarrow ? 6 : 8;
  const charHeight = 11;
  const maxCol = useNarrow ? 5 : 7;
  
  for (let row = 0; row < charHeight; row++) {
    for (let col = 0; col < charWidth; col++) {
      if (bitmap[row] & (1 << (maxCol - col))) {
        const px = x + col;
        const py = y + row;
        if (px >= 0 && px < width && py >= 0 && py < height) {
          const offset = (py * width + px) * 4;
          buffer[offset] = color.b;
          buffer[offset + 1] = color.g;
          buffer[offset + 2] = color.r;
          buffer[offset + 3] = color.a;
        }
      }
    }
  }
  return charWidth;
}

/**
 * Generate a single percentage badge icon with colored background and bitmap text
 * @param {number} percent - Usage percentage (0-100)
 * @param {object} bgColor - Background color {r, g, b}
 * @returns {NativeImage} Generated tray icon
 */
function generatePercentageIcon(percent, bgColor) {
  const width = 20;  // Back to 20x20
  const height = 20;
  const buffer = Buffer.alloc(width * height * 4);
  
  // Draw filled square background
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      buffer[offset] = bgColor.b;
      buffer[offset + 1] = bgColor.g;
      buffer[offset + 2] = bgColor.r;
      buffer[offset + 3] = 255;
    }
  }
  
  // Draw white text
  const percentText = Math.round(percent).toString();
  const textColor = { r: 255, g: 255, b: 255, a: 255 };
  
  // Use narrow font for 3-digit numbers (100%)
  const useNarrow = percentText.length >= 3;
  const charWidth = useNarrow ? 6 : 8;
  const charHeight = 11;
  const gap = percentText.length >= 3 ? 0 : 1; // 1px gap for 1-2 digits, no gap for 100
  const totalWidth = percentText.length * charWidth + (percentText.length - 1) * gap;
  let startX = Math.floor((width - totalWidth) / 2);
  const startY = Math.floor((height - charHeight) / 2);
  
  // Draw each digit
  for (let i = 0; i < percentText.length; i++) {
    drawChar(buffer, width, height, percentText[i], startX, startY, textColor, useNarrow);
    startX += charWidth + gap;
  }
  
  return nativeImage.createFromBuffer(buffer, { width, height });
}

/**
 * Generate a neutral "no reading" tray icon — a grey square with a white dash.
 * Used whenever an account has no usable reading, so an unknown value is never
 * painted as a green 0%.
 * @returns {NativeImage}
 */
function generateUnknownIcon() {
  const width = 20;
  const height = 20;
  const buffer = Buffer.alloc(width * height * 4);
  const grey = STATUS_COLORS.unknown;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      buffer[offset] = grey.b;
      buffer[offset + 1] = grey.g;
      buffer[offset + 2] = grey.r;
      buffer[offset + 3] = 255;
    }
  }

  // Centred white dash, 2px thick.
  for (let y = 9; y <= 10; y++) {
    for (let x = 5; x < 15; x++) {
      const offset = (y * width + x) * 4;
      buffer[offset] = 255;
      buffer[offset + 1] = 255;
      buffer[offset + 2] = 255;
      buffer[offset + 3] = 255;
    }
  }

  return nativeImage.createFromBuffer(buffer, { width, height });
}

/**
 * Generate a Red X icon for 99-100% usage (maxed out)
 * @returns {NativeImage} Generated red X tray icon
 */
function generateRedXIcon() {
  const width = 20;
  const height = 20;
  const buffer = Buffer.alloc(width * height * 4);
  
  // Red background
  const red = { r: 220, g: 53, b: 69 }; // #dc3545
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      buffer[offset] = red.b;
      buffer[offset + 1] = red.g;
      buffer[offset + 2] = red.r;
      buffer[offset + 3] = 255;
    }
  }
  
  // Draw white X (2 pixel thick lines)
  const white = { r: 255, g: 255, b: 255, a: 255 };
  
  // Diagonal line from top-left to bottom-right
  for (let i = 0; i < 11; i++) {
    const x1 = 5 + i;
    const y1 = 5 + i;
    // Draw 2x2 pixel for thickness
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const px = x1 + dx;
        const py = y1 + dy;
        if (px < width && py < height) {
          const offset = (py * width + px) * 4;
          buffer[offset] = white.b;
          buffer[offset + 1] = white.g;
          buffer[offset + 2] = white.r;
          buffer[offset + 3] = white.a;
        }
      }
    }
  }
  
  // Diagonal line from top-right to bottom-left
  for (let i = 0; i < 11; i++) {
    const x1 = 15 - i;
    const y1 = 5 + i;
    // Draw 2x2 pixel for thickness
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const px = x1 + dx;
        const py = y1 + dy;
        if (px < width && py < height) {
          const offset = (py * width + px) * 4;
          buffer[offset] = white.b;
          buffer[offset + 1] = white.g;
          buffer[offset + 2] = white.r;
          buffer[offset + 3] = white.a;
        }
      }
    }
  }
  
  return nativeImage.createFromBuffer(buffer, { width, height });
}



/**
 * Show the main window without the double-blink artifact on Windows.
 *
 * On Windows, transparent + alwaysOnTop + frameless windows re-enter the DWM
 * compositing pipeline in two steps when shown after hide(): an initial layered
 * window render (blink 1) followed by the alwaysOnTop z-order re-assertion
 * (blink 2). Setting opacity to 0 before show() masks those intermediate states;
 * the window is made opaque again after the DWM has had time to settle (~3 frames).
 * macOS and Linux do not have this issue so they just call show() directly.
 */
function showMainWindowClean() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Rows for display in the tray tooltip/menu: [{ label, pct }] where pct is
// null for a row that carries no reading. Normalized data carries its own
// rows; legacy payloads fall back to the two fixed rows.
function displayRows(data) {
  if (!data) return [];
  if (Array.isArray(data.rows)) {
    return data.rows.map((r) => ({
      label: r.shortLabel || r.label,
      pct: isRowAvailable(r) ? Math.round(r.utilization) : null
    }));
  }
  return [
    { label: 'S', pct: readPercent(data.five_hour?.utilization) },
    { label: 'W', pct: readPercent(data.seven_day?.utilization) }
  ];
}

// "45%" for a reading, "—" for a row that has none. Never renders 0% for an
// unknown value.
function formatTrayPct(pct) {
  return pct === null || pct === undefined ? '—' : `${pct}%`;
}

// What the numbers on a tray line actually are, when they are not a fresh
// automatic reading.
function readingSuffix(data) {
  if (!data) return '  (no reading)';
  if (data.status === READ_STATUS.UNAVAILABLE) return '  (unavailable)';
  if (data.stale || data.status === READ_STATUS.STALE) return '  (stale)';
  if (data.fallback) return '  (manual fallback)';
  if (data.source === 'manual') return '  (manual)';
  return '';
}

// Tray badge for one percentage: a neutral dash when there is no reading, the
// maxed-out X at 99%+, otherwise the status-coloured number.
function trayIconFor(percent) {
  if (percent === null || percent === undefined) return generateUnknownIcon();
  if (percent >= 99) return generateRedXIcon();
  return generatePercentageIcon(percent, statusColorFor(percent));
}

// Build the tray context menu: one (disabled) detail line per account with its
// per-row numbers — the "full detail" popup — plus the shared controls.
function buildTrayMenu() {
  const template = [];
  const accounts = getAccounts();
  for (const a of accounts) {
    const data = usageStateByAccount[a.id] && usageStateByAccount[a.id].data;
    const rows = displayRows(data);
    const label = rows.length
      ? `${a.label}:  ${rows.map((r) => `${r.label} ${formatTrayPct(r.pct)}`).join('  ·  ')}${readingSuffix(data)}`
      : `${a.label}:  —${readingSuffix(data)}`;
    template.push({ label, enabled: false });
  }
  if (accounts.length) template.push({ type: 'separator' });

  template.push({
    label: 'Show Widget',
    click: () => {
      if (mainWindow) {
        showMainWindowClean();
      } else {
        createMainWindow();
      }
    }
  });
  template.push({
    label: 'Refresh',
    click: () => {
      if (mainWindow) {
        mainWindow.webContents.send('refresh-usage');
      }
    }
  });
  template.push({ type: 'separator' });
  template.push({ label: 'Exit', click: () => app.quit() });

  return Menu.buildFromTemplate(template);
}

function createTray() {
  // Respect the tray stats setting even when createTray is called from generic refresh paths.
  if (!store.get('settings.showTrayStats', false)) {
    destroyTrayIcons();
    return;
  }

  // Rebuild from a clean state if only one of the two stats tray icons survived.
  const hasSessionTray = sessionTray && !sessionTray.isDestroyed();
  const hasWeeklyTray = weeklyTray && !weeklyTray.isDestroyed();
  if (hasSessionTray && hasWeeklyTray) return;
  if (hasSessionTray || hasWeeklyTray) destroyTrayIcons();

  try {
    const staticIconPath = path.join(__dirname, process.platform === 'darwin' ? 'assets/tray-icon-mac.png' : process.platform === 'linux' ? 'assets/tray-icon-linux.png' : 'assets/tray-icon.png');
    
    // Create Weekly tray icon FIRST (left position)
    weeklyTray = new Tray(staticIconPath);
    weeklyTray.setToolTip('Weekly Usage');

    // Create Session tray icon SECOND (right position)
    sessionTray = new Tray(staticIconPath);
    sessionTray.setToolTip('Session Usage');

    const contextMenu = buildTrayMenu();
    sessionTray.setContextMenu(contextMenu);
    weeklyTray.setContextMenu(contextMenu);

    // Click handlers - swapped order
        weeklyTray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
          mainWindow.hide();
        } else {
          showMainWindowClean();
        }
      }
    });
    
        sessionTray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
          mainWindow.hide();
        } else {
          showMainWindowClean();
        }
      }
    });
  } catch (error) {
    console.error('Failed to create tray:', error);
  }
}

function destroyTrayIcons() {
  // Centralized tray cleanup keeps Linux appindicator hosts from showing stale icons.
  const trays = [sessionTray, weeklyTray];
  sessionTray = null;
  weeklyTray = null;

  for (const tray of trays) {
    if (!tray || tray.isDestroyed()) continue;

    try {
      tray.removeAllListeners();
      tray.setContextMenu(null);
      tray.setToolTip('');

      // On Linux, some appindicator hosts repaint stale tray entries lazily.
      // Clearing the image before destroy gives the host an explicit update.
      if (process.platform === 'linux') {
        tray.setImage(nativeImage.createEmpty());
      }
    } catch (error) {
      console.error('Failed to clear tray icon:', error);
    }

    try {
      tray.destroy();
    } catch (error) {
      console.error('Failed to destroy tray icon:', error);
    }
  }
}

/**
 * Format reset time for tray tooltip
 * @param {string} resetsAt - ISO timestamp string
 * @param {string} timeFormat - '12h' or '24h'
 * @param {boolean} includeDate - Whether to include the date (for weekly resets)
 * @returns {string} Formatted time string
 */
function formatResetTime(resetsAt, timeFormat, includeDate = false) {
  if (!resetsAt) return null;
  const date = new Date(resetsAt);
  
  const formatTime = () => {
    if (timeFormat === '24h') {
      return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    } else {
      let hours = date.getHours();
      const minutes = date.getMinutes().toString().padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12 || 12;
      return `${hours}:${minutes} ${ampm}`;
    }
  };
  
  if (includeDate) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthStr = months[date.getMonth()];
    const dayNum = date.getDate();
    return `${monthStr} ${dayNum}, ${formatTime()}`;
  } else {
    return formatTime();
  }
}

/**
 * Update tray icons with current usage data
 * @param {Object} usageData - Usage data object containing session and weekly percentages
 */
// One short tooltip line per account, e.g. "Personal: 5h 45% / 7d 60%".
function trayTooltipLines() {
  return getAccounts().map((a) => {
    const data = usageStateByAccount[a.id] && usageStateByAccount[a.id].data;
    const rows = displayRows(data);
    if (!rows.length) return `${a.label}: —${readingSuffix(data)}`;
    return `${a.label}: ${rows.map((r) => `${r.label} ${formatTrayPct(r.pct)}`).join(' / ')}${readingSuffix(data)}`;
  });
}

// Roll every account up into the two tray badges: the worst account drives the
// numbers, while the tooltip and context menu carry per-account detail. Replaces
// the single-account updateTrayIcon().
function updateTrayRollup() {
  const showTrayStats = store.get('settings.showTrayStats', false);

  if (!showTrayStats) {
    // Destroy only weeklyTray, keeping sessionTray alive as a persistent restore
    // icon. Without it, hide() on Windows leaves no way to restore the window.
    // Apply the same Linux appindicator cleanup that destroyTrayIcons() uses.
    if (weeklyTray && !weeklyTray.isDestroyed()) {
      try {
        weeklyTray.removeAllListeners();
        weeklyTray.setContextMenu(null);
        weeklyTray.setToolTip('');
        if (process.platform === 'linux') weeklyTray.setImage(nativeImage.createEmpty());
        weeklyTray.destroy();
      } catch (_) {}
      weeklyTray = null;
    }
    return;
  }

  // Recreate tray icons if they were destroyed
  if (!sessionTray || sessionTray.isDestroyed() || !weeklyTray || weeklyTray.isDestroyed()) {
    createTray();
  }
  if ((!sessionTray || sessionTray.isDestroyed()) && (!weeklyTray || weeklyTray.isDestroyed())) return;

  // No account with a usable reading ⇒ null, which paints the neutral dash
  // badge rather than a green 0%.
  const worst = computeWorstAccount(getAccounts(), usageDataByAccount());
  const sessionPercent = worst ? worst.sessionPct : null;
  const weeklyPercent = worst ? worst.weeklyPct : null;

  const header = worst
    ? `Closest to limit: ${worst.account.label}${worst.stale ? ' (stale)' : ''}`
    : 'AI Usage';
  const tooltip = [header, ...trayTooltipLines()].join('\n');

  try {
    // Weekly icon — LEFT position, status-colored (green/orange/red/grey)
    const weeklyIcon = trayIconFor(weeklyPercent);
    if (weeklyTray && !weeklyTray.isDestroyed()) {
      weeklyTray.setImage(weeklyIcon);
      weeklyTray.setToolTip(tooltip);
    }

    // Session icon — RIGHT position, status-colored (green/orange/red/grey)
    const sessionIcon = trayIconFor(sessionPercent);
    if (sessionTray && !sessionTray.isDestroyed()) {
      sessionTray.setImage(sessionIcon);
      sessionTray.setToolTip(tooltip);
    }

    // Refresh the context menu so its per-account detail lines stay current.
    const menu = buildTrayMenu();
    if (sessionTray && !sessionTray.isDestroyed()) sessionTray.setContextMenu(menu);
    if (weeklyTray && !weeklyTray.isDestroyed()) weeklyTray.setContextMenu(menu);
  } catch (error) {
    console.error('Failed to update tray icons:', error);
  }
}


// IPC Handlers — account management

// List accounts for the renderer (never returns the sessionKey itself).
ipcMain.handle('get-accounts', () => {
  return getAccounts().map((a) => {
    const credential = credentials.credentialState(a.id);
    return {
      id: a.id,
      label: a.label,
      provider: a.provider || 'claude',
      orgId: a.orgId,
      partition: partitionFor(a.id),
      organizations: a.organizations || [],
      manual: a.manual || null,
      // "There is a credential for this account", which is what decides
      // whether the action reads Connect or Reconnect. A locked keychain still
      // counts: the credential exists, it just cannot be opened yet. Nothing
      // counts that is not in a file — a credential the app is merely holding
      // in memory is exactly what this app refuses to have.
      hasSession: credential.persisted,
      // The honest detail behind that flag, so a card can say "secure storage
      // unavailable" instead of the untrue "not connected".
      credentialState: credential.state,
      credentialUsable: credential.usable
    };
  });
});

// What the OS offers for credential protection right now. The renderer uses
// this to explain a refused sign-in and to offer manual tracking instead.
ipcMain.handle('get-secure-storage', () => credentials.security());

ipcMain.handle('get-config-health', () => ({ ...configHealth }));

// Allocate an id + partition for a not-yet-saved account. The login/manual
// capture binds to this partition; nothing is persisted until save-account.
ipcMain.handle('create-draft-account', () => {
  const id = nextAccountId();
  return { id, partition: partitionFor(id), label: defaultLabel(getAccounts().length) };
});

/**
 * Put the account's credential back the way this save found it.
 *
 * Called when the save cannot finish what it started: the cookie write threw,
 * or the account list would not reach the disk. Either way the durable
 * credential has already been replaced, and leaving the replacement behind
 * while reporting failure is what made "nothing changed" untrue.
 *
 * Three outcomes, all of them reported rather than assumed:
 *   - restored: the previous credential is back in the store;
 *   - deleted: there was no previous credential (a first save), so the one
 *     this save wrote is removed;
 *   - unrecoverable: there WAS one, but it could not be read before being
 *     overwritten (a locked or unreadable keychain), so it cannot be put back.
 *     The caller reports this precise condition; it never claims a clean
 *     rollback.
 *
 * No credential value is logged or returned - only the outcome.
 */
/**
 * What is committed for this account's credential right now: the secret (when
 * it can be read), the mode, and the store's own answer to "is there one in a
 * file". A save captures this BEFORE it writes, so it can put it back.
 */
function captureCommittedCredential(id) {
  const loaded = loadAccountCredential(id);
  return {
    key: loaded.key,
    mode: loaded.mode,
    persisted: credentials.credentialState(id).persisted === true
  };
}

/**
 * Put the account's PARTITION back the way this save found it.
 *
 * A rollback that restores the credential but leaves the replacement cookie in
 * the account's persistent partition has not restored anything: the secret the
 * save was withdrawing is still on disk, in the user's profile, and the next
 * read will authenticate with it. So the cookie follows the credential.
 *
 * @returns {{outcome: string, reason?: string}} 'restored' | 'cleared' | 'incomplete'
 */
async function restorePreviousPartition(id, provider, previous) {
  try {
    if (previous && previous.persisted === true && previous.key) {
      await setSessionCookie(previous.key, id, provider);
      return { outcome: 'restored' };
    }
    // There was nothing committed here, so nothing may remain: clear the
    // provider cookies this save could have written.
    const sess = getAccountSession(id);
    for (const spec of Object.values(PROVIDER_COOKIES)) {
      const cookies = await sess.cookies.get({ url: spec.url });
      for (const cookie of cookies) await sess.cookies.remove(spec.url, cookie.name);
    }
    return { outcome: 'cleared' };
  } catch (err) {
    return { outcome: 'incomplete', reason: err.message };
  }
}

function restorePreviousCredential(id, previous) {
  if (!previous || previous.persisted !== true) {
    const removal = deleteAccountKey(id);
    return {
      outcome: removal.removed === false ? 'incomplete' : 'deleted',
      reason: removal.removed === false
        ? ((removal.failures && removal.failures[0] && removal.failures[0].error) || 'delete-failed')
        : undefined
    };
  }
  if (!previous.key) {
    return { outcome: 'unrecoverable', reason: previous.mode };
  }
  const saved = saveAccountKey(id, previous.key);
  return {
    outcome: saved.saved === true ? 'restored' : 'incomplete',
    reason: saved.saved === true ? undefined : saved.reason
  };
}

// Persist (or update) an account, storing its credential in the partition
// cookie jar plus an encrypted backup. provider is 'claude' (sessionKey) or
// 'chatgpt' (next-auth session token).
//
// THE COMMITMENT BOUNDARY. Nothing about the committed account changes until
// the credential is durably stored AND its cookie has been written. Before
// that point the only things this handler has touched are the credential
// itself (which it can put back) and an in-memory operation; the account row
// is not reserved, not tagged and not edited. That is what makes a reconnect
// and a brand-new draft different identities all the way through: the draft
// has no row to cancel, and the reconnect's row is a committed account that
// cancellation may not touch.
ipcMain.handle('save-account', async (event, { id, label, provider, sessionKey, organizationId, organizations, flowId }) => {
  const partition = partitionFor(id);
  const flow = flowId === undefined || flowId === null ? null : authFlowsByPartition.get(partition);
  if (flowId !== undefined && flowId !== null && (!flow || flow.flowId !== flowId || flow.cancelled)) {
    return false;
  }

  const ops = accountOpsFor(id);
  // A removal that is draining and wiping this account's partition owns it
  // until it finishes. Writing a credential into a partition that is about to
  // be cleared - or after it has been - is the defect this refusal closes.
  if (ops.removing) {
    debugLog(`[Account] Refused a save for account ${id}: a removal owns it`);
    return { ok: false, reason: 'account-removing' };
  }
  // And once a removal has FINISHED, that id is closed for good. Account ids
  // only ever go up (accountSeq), so nothing legitimate ever saves to a removed
  // id again - and allowing it would be a route for a credential to land back
  // in a partition the user was told had been wiped.
  if (ops.removed) {
    debugLog(`[Account] Refused a save for account ${id}: it was removed`);
    return { ok: false, reason: 'account-removed' };
  }

  // Identity, decided once. Everything after this treats `isReconnect` as the
  // truth about what is being saved, however the account list changes while
  // the cookie write is in flight.
  const previousAccount = getAccount(id);
  const isReconnect = !!previousAccount;
  const previousCredential = isReconnect ? captureCommittedCredential(id) : null;

  const op = beginAccountOperation(id, 'save', { draft: !isReconnect });

  try {
    // Take ownership of the account's read state before anything else. A read
    // that is already in flight carries the previous generation, so from this
    // point it can neither report a failure against the credential this save
    // is about to write nor delete it. A read that STARTS during the save sees
    // a pending operation and abandons itself for the same reason.
    bumpAccountGeneration(id);

    // Persist the credential next. If it cannot be stored durably and under OS
    // protection, nothing is written anywhere: no plaintext in config.json, and
    // no cookie in the account's persistent Chromium partition either - writing
    // the secret into a partition on disk would be the same exposure by another
    // route. The renderer explains the refusal and offers manual tracking.
    const stored = saveAccountKey(id, sessionKey);
    if (!stored.saved) {
      const security = credentials.security();
      console.warn(`[Account] Refused to persist a credential for account ${id}: ${stored.reason}`);
      return { ok: false, reason: 'insecure-storage', detail: stored.reason, security };
    }

    try {
      await setSessionCookie(sessionKey, id, provider);
    } catch (cookieError) {
      // The partition was sealed underneath us - a removal owns this account
      // now. Its credential and its row are the removal's to delete; this save
      // simply stands down.
      if (cookieError && cookieError.message === STALE_READ) {
        debugLog(`[Account] Save for account ${id} was superseded before its cookie write landed`);
        finishAuthFlow(partition, flowId);
        return { ok: false, reason: 'superseded' };
      }
      // A real cookie failure. The committed account is exactly as it was
      // except for the credential this save replaced, so that goes back - and
      // so does whatever the partition holds, since a half-written cookie is
      // the same secret by another route.
      const rollback = restorePreviousCredential(id, previousCredential);
      const partitionRollback = await restorePreviousPartition(id, provider, previousCredential);
      if (partitionRollback.outcome === 'incomplete') {
        console.error(`[Account] Cookie rollback for account ${id} did not complete (${partitionRollback.reason}) - its partition may still hold a cookie this save wrote`);
      }
      if (rollback.outcome === 'restored' || rollback.outcome === 'deleted') {
        console.error(`[Account] Cookie write failed for account ${id} (${cookieError.message}) - previous credential ${rollback.outcome}`);
      } else {
        console.error(`[Account] Cookie write failed for account ${id} (${cookieError.message}) - ROLLBACK INCOMPLETE (${rollback.outcome}: ${rollback.reason}). The stored credential is the one this save wrote and could not withdraw; reconnect to replace it.`);
      }
      finishAuthFlow(partition, flowId);
      cookieError.rollback = rollback;
      cookieError.partitionRollback = partitionRollback;
      throw cookieError;
    }

    // Recheck ownership before committing. Removal, draft cancellation and a
    // later save all supersede this operation, and in none of those cases may
    // it write an account list.
    if (!accountOperationLives(op)) {
      debugLog(`[Account] Save for account ${id} was superseded during its cookie write (${op.cancelledBy}) - nothing committed`);
      finishAuthFlow(partition, flowId);
      return { ok: false, reason: 'superseded' };
    }

    // Commit. A NEW list with a NEW row object, not an edit of the objects the
    // store handed back: a refused write must leave the account exactly as it
    // was, and mutating the store's own objects first means "refused" and
    // "applied" look identical in memory. The row is written once, complete,
    // with no reservation marker of any kind - including one an older build
    // may have left on it.
    const current = getAccounts();
    // A snapshot to restore if the write is refused. `setAccounts` answers a
    // rejected durable write by keeping the value in a session overlay, so
    // without this the running app would show the reconnected account while
    // the credential underneath it had just been rolled back to the previous
    // one - the two disagreeing is exactly the partial commit being removed.
    const committedBefore = JSON.parse(JSON.stringify(current));
    const existing = current.find((a) => a.id === id);
    let accounts;
    if (existing) {
      const replacement = { ...existing };
      if (label !== undefined) replacement.label = label;
      if (provider !== undefined) replacement.provider = provider;
      if (organizationId !== undefined) replacement.orgId = organizationId;
      if (organizations !== undefined) replacement.organizations = organizations;
      delete replacement.saveClaim;
      accounts = current.map((a) => (a.id === id ? replacement : a));
    } else {
      accounts = [...current, {
        id,
        label: label || defaultLabel(current.length),
        provider: provider || 'claude',
        orgId: organizationId,
        organizations: organizations || []
      }];
    }
    const written = setAccounts(accounts);
    // The committed account is itself a new generation: a read that started
    // during the cookie write is looking at the account as it was before.
    bumpAccountGeneration(id);
    finishAuthFlow(partition, flowId);

    // Reported, not assumed: an account the config file rejected is an account
    // the user will not have at the next launch. The credential goes back with
    // it, so the two do not disagree on disk.
    if (written && written.persisted === false) {
      const rollback = restorePreviousCredential(id, previousCredential);
      const partitionRollback = await restorePreviousPartition(id, provider, previousCredential);
      // Put the session's view of the account list back too, so nothing in the
      // running app shows a commit that did not happen.
      setAccounts(committedBefore);
      bumpAccountGeneration(id);
      console.error(`[Account] Account list write failed for account ${id} (${written.reason}) - credential rollback: ${rollback.outcome}, partition rollback: ${partitionRollback.outcome}`);
      updateTrayRollup();
      return {
        ok: false,
        reason: 'not-persisted',
        detail: written.reason,
        rollback: rollback.outcome,
        rollbackDetail: rollback.reason,
        partitionRollback: partitionRollback.outcome
      };
    }
    updateTrayRollup();
    return true;
  } finally {
    endAccountOperation(op);
  }
});

// Per-account manual usage entry: { enabled, used, limit }. Used as the
// fallback when auto-reading is unavailable or disabled for that account.
ipcMain.handle('save-account-manual', (event, { id, manual }) => {
  const accounts = getAccounts();
  const account = accounts.find((a) => a.id === id);
  if (!account) return { ok: false, reason: 'unknown-account' };

  // Clearing the entry is allowed; supplying one that is not a pair of usable
  // numbers is refused with a reason rather than coerced to zeroes. Usage
  // above the limit stays supported.
  let stored = null;
  if (manual) {
    const validation = validateManualEntry(manual);
    if (!validation.valid) return { ok: false, reason: 'invalid-manual', errors: validation.errors };
    stored = validation.manual;
  }

  {
    account.manual = stored;
    setAccounts(accounts);
    // A settings change invalidates the displayed reading but is not a read:
    // clear the payload and leave lastSuccessAt exactly where it was.
    const state = usageStateFor(id);
    state.data = null;
    state.status = READ_STATUS.LOADING;
    // A changed manual mode changes what a read means, so any in-flight read
    // for this account no longer applies.
    bumpAccountGeneration(id);
    updateTrayRollup();
  }
  return { ok: true, manual: stored };
});

// Create (or convert) an account that is tracked entirely by hand: no provider
// login, no credential, no partition cookie. This is what the first-run
// "Track it myself" path uses, so a user whose automatic login fails — or who
// never wanted one — can still set the widget up.
ipcMain.handle('create-manual-account', (event, { id, label, provider, manual }) => {
  const validation = validateManualEntry(manual);
  if (!validation.valid) return { ok: false, reason: 'invalid-manual', errors: validation.errors };

  const accounts = getAccounts();
  const existing = accounts.find((a) => a.id === id);
  if (existing) {
    if (label !== undefined) existing.label = label;
    if (provider !== undefined) existing.provider = provider;
    existing.manual = validation.manual;
  } else {
    accounts.push({
      id,
      label: label || defaultLabel(accounts.length),
      provider: provider || 'claude',
      orgId: null,
      organizations: [],
      manual: validation.manual
    });
  }
  setAccounts(accounts);
  bumpAccountGeneration(id);
  updateTrayRollup();
  return { ok: true, manual: validation.manual };
});

/**
 * What is still on disk for an account id, whether or not it still has a row.
 *
 * Used to decide whether a removal for an id with no account row is a no-op or
 * an unfinished cleanup that must be completed. `label` is remembered from the
 * row when there is one, so a retry can still name the account.
 */
function accountLeftovers(id) {
  const row = getAccount(id);
  let credential = false;
  try {
    credential = credentials.credentialState(id).persisted === true;
  } catch (err) {
    // Unreadable is not absent: treat it as something still to clean up.
    credential = true;
    debugLog(`[Account] Could not inspect the credential for ${id}: ${err.message}`);
  }
  let history = false;
  try {
    const durable = durableFacetOf(store);
    history = durable ? durable.has(`usageHistory_acct_${id}`) : store.has(`usageHistory_acct_${id}`);
  } catch (err) {
    history = true;
    debugLog(`[Account] Could not inspect the history for ${id}: ${err.message}`);
  }
  return {
    row: !!row,
    label: row ? row.label : undefined,
    credential,
    history,
    anything: !!row || credential || history
  };
}

// Remove an account: its record, its credential, its history, and everything
// inside the partition it owns. Only that partition - the call is scoped to
// `persist:acct-<id>`, so no other account's cookies or storage are reachable
// from here.
//
// THE ORDER IS THE FIX. A removal used to clear the partition while cookie
// writes for the same account were still in flight, so it could report "all
// storage cleared" and then have the login cookie written back behind it - by
// a save it had already superseded, or by a refresh poll that belonged to no
// login flow at all and was therefore invisible to every existing guard.
//
// So: supersede the other operations, take the record and the credential off
// disk, SEAL the account against new cookie writes, DRAIN the writes already
// in flight, and only then wipe. Nothing older can write after that, and the
// result says so.
//
// What it reports is what actually happened. Every durable delete and every
// partition step is checked individually, and anything that did not happen is
// named in `remaining` so the renderer can say which data is still there
// instead of showing a clean list.
ipcMain.handle('remove-account', async (event, id) => {
  const account = getAccount(id);
  // Removal is IDEMPOTENT, because it has to be retryable. A removal that got
  // as far as deleting the account row and then could not delete the history
  // leaves no row to find, and the user is looking at a notice offering to try
  // again: refusing that retry as "unknown account" would clear the notice
  // while the data it named was still on disk. So "the row is gone" is only
  // "nothing to do" when nothing else is left either.
  const leftovers = accountLeftovers(id);
  if (!account && !leftovers.anything) return { ok: false, reason: 'unknown-account' };
  const label = account ? account.label : (leftovers.label || String(id));

  const ops = accountOpsFor(id);
  ops.removing = true;
  // Supersedes every in-flight save and discard for this account: each will
  // find its operation cancelled and commit nothing.
  const op = beginAccountOperation(id, 'remove');
  const remaining = [];

  try {
    // Invalidate in-flight reads for this account before anything is deleted,
    // so one that is mid-await cannot write history or state back afterwards.
    bumpAccountGeneration(id);

    if (account) {
      const written = setAccounts(getAccounts().filter((a) => a.id !== id));
      if (written && written.persisted === false) {
        remaining.push({ what: 'account', detail: written.reason || 'config-write-failed' });
      }
    }

    const credentialRemoval = deleteAccountKey(id);
    if (credentialRemoval && credentialRemoval.removed === false
        && credentials.credentialState(id).persisted === true) {
      remaining.push({
        what: 'credential',
        detail: (credentialRemoval.failures && credentialRemoval.failures[0] && credentialRemoval.failures[0].error)
          || 'credential-delete-failed'
      });
    }

    delete usageStateByAccount[id];
    // History goes through the durable facet and is CHECKED. Deleting it
    // through the resilient overlay alone made a rejected delete look like a
    // success for the rest of the session and brought the history back at the
    // next launch, under a removal that had reported itself complete.
    const historyKey = `usageHistory_acct_${id}`;
    const historyRemoval = deleteDurableKey(historyKey);
    // A refused delete only leaves history behind if there was history. The
    // report has to be accurate in both directions: it must not claim a clean
    // removal over data that is still there, and it must not name data that
    // was never there.
    if (historyRemoval && historyRemoval.removed === false && accountLeftovers(id).history) {
      remaining.push({ what: 'history', detail: historyRemoval.reason || 'history-delete-failed' });
    }

    // No new cookie write may start for this account from here on.
    sealAccount(id, true);
    // Wait for the ones already in flight. A save's cookie write that is
    // sitting inside Chromium's cookie store right now WILL land; the point is
    // that it lands before the wipe rather than after it.
    const drained = await drainAccountWrites(id);
    if (!drained) {
      remaining.push({ what: 'pending-writes', detail: 'a cookie write for this account did not settle in time' });
    }

    const cleared = { storage: false, cache: false, authCache: false };
    try {
      const sess = session.fromPartition(partitionFor(id));
      // No `storages` and no `origin`: every storage type, every origin, inside
      // this partition. Cookies included.
      await sess.clearStorageData();
      cleared.storage = true;
      await sess.clearCache();
      cleared.cache = true;
      await sess.clearAuthCache();
      cleared.authCache = true;
      await sess.cookies.flushStore();
    } catch (err) {
      console.error(`[Account] Failed to clear partition for ${id}:`, err.message);
      remaining.push({ what: 'partition', detail: err.message });
    }
    for (const [step, ok] of Object.entries(cleared)) {
      if (!ok) remaining.push({ what: `partition-${step}`, detail: 'not cleared' });
    }

    updateTrayRollup();
    // "Removed" must mean removed. If any durable write or any partition step
    // failed, the account (or its credential, or its history) is still there
    // and will be back at the next launch, and the renderer says so rather
    // than showing a clean list.
    const persisted = remaining.length === 0;
    if (!persisted) {
      console.error(`[Account] Removal of account ${id} is incomplete: ${remaining.map((r) => `${r.what} (${r.detail})`).join('; ')}`);
    }
    return {
      ok: true,
      id: String(id),
      label,
      cleared,
      drained,
      persisted,
      remaining,
      detail: persisted ? undefined : remaining.map((r) => r.what).join(', ')
    };
  } finally {
    ops.removing = false;
    ops.removed = true;
    endAccountOperation(op);
    // The seal stays on. Account ids are never reused (accountSeq only ever
    // goes up), so nothing legitimate needs to write to this partition again,
    // and a straggler that appears after the wipe must still be refused.
  }
});

// Discard a never-saved draft account: wipe its partition and nothing else.
//
// A DRAFT is an id that has no committed account row. That is the whole test,
// and it is the same test the save used when it decided its own identity, so
// the two cannot disagree. The previous version treated "the row carries a
// saveClaim" as "this is a draft", which meant that during a RECONNECT - where
// the old code tagged the existing, committed account with a claim - this
// handler deleted a saved account, its credential and its history, and
// reported true. Its documented promise to refuse saved account ids did not
// hold exactly when it mattered.
//
// Ownership of an in-flight save now lives in memory, so a committed account
// is never mistaken for a reservation: the refusal below is unconditional.
ipcMain.handle('discard-draft-account', async (event, id) => {
  const account = getAccount(id);
  if (account) {
    // A row left behind by an OLDER build's interrupted save is the one
    // exception, and it is a migration case rather than a lifecycle one: this
    // version never writes a claim. Boot-time cleanup normally deals with
    // these; if one is still here, it was never a committed account.
    if (account.saveClaim) {
      bumpAccountGeneration(id);
      setAccounts(getAccounts().filter((a) => a.id !== id));
      deleteAccountKey(id);
      debugLog(`[Account] Discarded a row reserved by an older build's interrupted save for account ${id}`);
    } else {
      // A committed account is not a draft, whatever is in flight for it.
      return false;
    }
  } else {
    // Cancel the draft save this discard belongs to, if one is running. A
    // reconnect is never cancelled here: it does not own a draft operation.
    const cancelled = cancelDraftOperations(id, 'discard');
    if (cancelled) debugLog(`[Account] Cancelled ${cancelled} in-flight draft save(s) for account ${id}`);
    // A draft save stores its credential before its cookie write, so a
    // cancelled draft can have left one behind even with no row to show for it.
    deleteAccountKey(id);
    bumpAccountGeneration(id);
  }

  const partition = partitionFor(id);
  const flow = authFlowsByPartition.get(partition);
  if (flow) {
    flow.cancelled = true;
    flow.controller.abort();
    await Promise.allSettled([...flow.pending]);
  }
  // Seal and drain for the same reason removal does: a cookie write that
  // belongs to no login flow - a poll, or the cancelled save's own write - must
  // land before the clear below, not after it.
  sealAccount(id, true);
  await drainAccountWrites(id);
  try {
    const sess = session.fromPartition(partition);
    for (const origin of ['https://claude.ai', 'https://chatgpt.com']) {
      const cookies = await sess.cookies.get({ url: origin });
      for (const cookie of cookies) {
        await sess.cookies.remove(origin, cookie.name);
      }
      await sess.clearStorageData({
        storages: ['localstorage', 'sessionstorage', 'cachestorage'],
        origin
      });
    }
  } catch (err) {
    console.error(`[Account] Failed to clear draft partition for ${id}:`, err.message);
  }
  // Unlike a removal, a discarded draft id can legitimately be saved again:
  // the renderer keeps the same draft while the user retries a login.
  sealAccount(id, false);
  if (authFlowsByPartition.get(partition) === flow) authFlowsByPartition.delete(partition);
  return true;
});

ipcMain.handle('rename-account', (event, { id, label }) => {
  const accounts = getAccounts();
  const account = accounts.find((a) => a.id === id);
  if (account) {
    account.label = label;
    setAccounts(accounts);
    updateTrayRollup();
  }
  return true;
});

// Validate a sessionKey by fetching the org list via a hidden BrowserWindow bound
// to the account's partition (bypasses Cloudflare). Returns the resolvable orgs.
ipcMain.handle('validate-session-key', (event, sessionKey, partition, flowId) => {
  const gate = checkLoginAllowed();
  if (!gate.allowed) {
    console.warn(`[Auth] Refused to validate a Claude session key: ${gate.reason}`);
    return { success: false, error: gate.error, reason: 'insecure-storage', security: gate.security };
  }
  const flow = beginAuthFlow(partition, flowId);
  return trackAuthOperation(flow, async () => {
    debugLog('Validating session key on partition', partition);
    const sess = partition ? session.fromPartition(partition) : session.defaultSession;
    if (partition) sess.setUserAgent(CHROME_USER_AGENT);
    try {
      if (!isAuthFlowActive(partition, flow)) return { success: false, error: 'Login cancelled' };
      // Set the cookie on the account's partition first
      await sess.cookies.set({
        url: 'https://claude.ai',
        name: 'sessionKey',
        value: sessionKey,
        domain: '.claude.ai',
        path: '/',
        secure: true,
        httpOnly: true
      });
      if (!isAuthFlowActive(partition, flow)) return { success: false, error: 'Login cancelled' };

      // Fetch organizations through that partition (bypasses Cloudflare)
      const data = await fetchViaWindow('https://claude.ai/api/organizations', {
        partition,
        signal: flow?.controller.signal
      });
      if (!isAuthFlowActive(partition, flow)) return { success: false, error: 'Login cancelled' };

      if (data && Array.isArray(data) && data.length > 0) {
        // Filter to orgs with 'chat' capability (excludes API-only orgs)
        const chatOrgs = data.filter((org) => org.capabilities && org.capabilities.includes('chat'));

        if (chatOrgs.length === 0) {
          return { success: false, error: 'No chat-enabled organizations found' };
        }

        // Prioritise a Team org if present, otherwise the first chat org
        const defaultOrg = chatOrgs.find((org) => org.raven_type === 'team') || chatOrgs[0];
        const orgId = defaultOrg.uuid || defaultOrg.id;

        debugLog(`Session key validated, found ${chatOrgs.length} chat org(s), default org ID:`, orgId);

        return {
          success: true,
          organizationId: orgId,
          organizations: chatOrgs.map((org) => ({
            id: org.uuid || org.id,
            name: org.name,
            isTeam: org.raven_type === 'team'
          }))
        };
      }

      if (data && data.error) {
        return { success: false, error: data.error.message || data.error };
      }

      return { success: false, error: 'No organization found' };
    } catch (error) {
      if (error.message === 'AuthFlowCancelled' || !isAuthFlowActive(partition, flow)) {
        return { success: false, error: 'Login cancelled' };
      }
      console.error('Session key validation failed:', error.message);
      // Clean up the invalid cookie on that partition
      try {
        await sess.cookies.remove('https://claude.ai', 'sessionKey');
      } catch (_) {}
      return { success: false, error: error.message };
    }
  });
});

// Validate a ChatGPT session token by reading the account's quota through the
// same hidden-window route used for polling. Returns the account tier when the
// token works (see src/providers.js for the endpoint + parsing).
ipcMain.handle('validate-chatgpt-token', (event, token, partition, flowId) => {
  const gate = checkLoginAllowed();
  if (!gate.allowed) {
    console.warn(`[Auth] Refused to validate a ChatGPT token: ${gate.reason}`);
    return { success: false, error: gate.error, reason: 'insecure-storage', security: gate.security };
  }
  const flow = beginAuthFlow(partition, flowId);
  return trackAuthOperation(flow, async () => {
    debugLog('Validating ChatGPT token on partition', partition);
    const sess = partition ? session.fromPartition(partition) : session.defaultSession;
    if (partition) sess.setUserAgent(CHROME_USER_AGENT);
    try {
      if (!isAuthFlowActive(partition, flow)) return { success: false, error: 'Login cancelled' };
      await sess.cookies.set({
        url: 'https://chatgpt.com',
        name: '__Secure-next-auth.session-token',
        value: token,
        domain: '.chatgpt.com',
        path: '/',
        secure: true,
        httpOnly: true
      });
      if (!isAuthFlowActive(partition, flow)) return { success: false, error: 'Login cancelled' };

      const validation = await validateChatGPTToken({ partition, signal: flow?.controller.signal });
      if (!isAuthFlowActive(partition, flow)) return { success: false, error: 'Login cancelled' };
      if (validation.success) return validation;
      return { success: false, error: validation.error || 'Login not detected — try again' };
    } catch (error) {
      if (error.message === 'AuthFlowCancelled' || !isAuthFlowActive(partition, flow)) {
        return { success: false, error: 'Login cancelled' };
      }
      console.error('ChatGPT token validation failed:', error.message);
      try {
        await sess.cookies.remove('https://chatgpt.com', '__Secure-next-auth.session-token');
      } catch (_) {}
      return { success: false, error: error.message };
    }
  });
});

ipcMain.on('minimize-window', () => {
  if (mainWindow) {
    if (process.platform === 'darwin') {
      mainWindow.minimize();
    } else {
      // Hiding is only safe when there is a tray icon to restore from.
      // "Hide from taskbar" plus no tray used to leave a running process with
      // no window and no way to bring one back.
      const minimizeToTray = store.get('settings.minimizeToTray', false);
      const hasTray = !!(sessionTray && !sessionTray.isDestroyed());
      if (minimizeToTray && hasTray) {
        mainWindow.hide();
      } else {
        if (minimizeToTray && !hasTray) {
          debugLog('[Window] Minimising instead of hiding: no tray icon exists to restore from');
        }
        mainWindow.minimize();
      }
    }
  }
});

ipcMain.on('close-window', () => {
  const showTrayStats = store.get('settings.showTrayStats', false);
  if (showTrayStats && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  } else {
    app.quit();
  }
});

// v2.0 free-resize model: the user owns the window size. The renderer's pointer-
// driven resize grips call this on every frame while dragging; it clamps to the
// minimum size (keeping the opposite edge fixed so the window doesn't jump) and
// applies the bounds directly, regardless of the `resizable` window flag.
ipcMain.handle('set-window-bounds', (event, bounds) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const current = mainWindow.getBounds();
  let width = Math.round(bounds.width ?? current.width);
  let height = Math.round(bounds.height ?? current.height);
  let x = Math.round(bounds.x ?? current.x);
  let y = Math.round(bounds.y ?? current.y);

  if (width < MIN_WINDOW_WIDTH) {
    if (x !== current.x) x = current.x + current.width - MIN_WINDOW_WIDTH;
    width = MIN_WINDOW_WIDTH;
  }
  if (height < MIN_WINDOW_HEIGHT) {
    if (y !== current.y) y = current.y + current.height - MIN_WINDOW_HEIGHT;
    height = MIN_WINDOW_HEIGHT;
  }

  mainWindow.setBounds({ x, y, width, height });

  // Consume the one-time first-run auto-size: the renderer measures its own
  // content height on first paint and calls this once to settle into it.
  if (firstRunAutoSize) {
    firstRunAutoSize = false;
    store.set('windowBounds', mainWindow.getBounds());
  }
  return true;
});

ipcMain.handle('get-window-bounds', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow.getBounds();
  }
  return null;
});

// Tells the renderer whether this is a true first run (no stored bounds yet),
// so it knows whether to perform the one-time content-height auto-size.
ipcMain.handle('get-window-init-info', () => {
  return {
    bounds: mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null,
    isFirstRun: firstRunAutoSize
  };
});

ipcMain.on('open-external', (event, url) => {
  // Trust boundary enforcement: duplicate allowlist check in main process
  const allowedDomains = ['claude.ai', 'chatgpt.com', 'openai.com', 'github.com', 'buymeacoffee.com'];
  try {
    const parsedUrl = new URL(url);
    const isAllowed = allowedDomains.some(domain => 
      parsedUrl.hostname === domain || parsedUrl.hostname.endsWith('.' + domain)
    );
    if (isAllowed) {
      shell.openExternal(url);
    } else {
      console.warn(`[Security] Blocked openExternal call to disallowed domain: ${parsedUrl.hostname}`);
    }
  } catch (err) {
    console.warn(`[Security] Blocked openExternal call with invalid URL: ${url}`);
  }
});

// The APP's version, never the runtime's.
//
// app.getVersion() returns the Electron version whenever Electron was not
// started with an app directory - which is exactly how the fixtures and the
// screenshot probe run it, and it is how "Application Version: v44.3.0"
// reached the Settings footer. package.json ships inside the asar, so reading
// it directly is correct in a packaged build and in development alike;
// app.getVersion() stays as the fallback.
const APP_VERSION = (() => {
  try {
    const pkg = require('./package.json');
    if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch (err) {
    console.error('[Version] Could not read package.json:', err.message);
  }
  return app.getVersion();
})();

ipcMain.handle('get-app-version', () => APP_VERSION);

// Where the update notification sends the user. Derived from the same two
// constants the check itself uses, so the link cannot drift away from the
// repository being checked.
ipcMain.handle('get-releases-url', () => releasesUrlFor(GITHUB_OWNER, GITHUB_REPO));

ipcMain.handle('get-usage-history', (event, accountId) => {
  const historyKey = `usageHistory_acct_${accountId}`;
  const history = store.get(historyKey, []);
  const cutoff = Date.now() - (CHART_DAYS * 24 * 60 * 60 * 1000);
  return history
    .filter((entry) => entry.timestamp > cutoff)
    .sort((a, b) => a.timestamp - b.timestamp);
});

// Show a native OS desktop notification (Windows toast, macOS NC, Linux libnotify)
ipcMain.on('show-notification', (event, { title, body }) => {
  if (Notification.isSupported()) {
    const n = new Notification({ title, body, silent: false });
    n.show();
  }
});

// Settings handlers. The theme and warn/danger thresholds are gone — the app
// is black-only with fixed status bands (green <80, orange 80–95, red ≥95).
ipcMain.handle('get-settings', () => {
  return {
    autoStart: store.get('settings.autoStart', false),
    minimizeToTray: store.get('settings.minimizeToTray', false),
    alwaysOnTop: store.get('settings.alwaysOnTop', true),
    timeFormat: store.get('settings.timeFormat', '12h'),
    weeklyDateFormat: store.get('settings.weeklyDateFormat', 'date'),
    usageAlerts: store.get('settings.usageAlerts', true),
    refreshInterval: store.get('settings.refreshInterval', '300'),
    graphVisible: store.get('settings.graphVisible', false),
    expandedOpen: store.get('settings.expandedOpen', false),
    showTrayStats: store.get('settings.showTrayStats', false),
    theme: storedTheme()
  };
});

// The theme toggle. Kept off the settings form on purpose: it applies the
// moment it is clicked, so it saves one value rather than committing every
// other control's current state as a side effect.
// Answered synchronously because the renderer's pre-paint bootstrap cannot
// await. See the note in preload.js.
ipcMain.on('get-theme-sync', (event) => {
  event.returnValue = storedTheme();
});

ipcMain.handle('set-theme', (event, theme) => {
  const resolved = normaliseTheme(theme);
  store.set('settings.theme', resolved);
  return { theme: resolved, persisted: configHealth.persistent !== false };
});

ipcMain.handle('save-settings', (event, settings) => {
  const isPortable = process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_FILE;
  // Portable builds skip autostart entirely — autorun via registry is unreliable
  // when the exe path changes with each version; users should use shell:startup.
  const autoStart = isPortable ? false : settings.autoStart;

  store.set('settings.autoStart', autoStart);
  store.set('settings.minimizeToTray', settings.minimizeToTray);
  store.set('settings.alwaysOnTop', settings.alwaysOnTop);
  store.set('settings.timeFormat', settings.timeFormat);
  store.set('settings.weeklyDateFormat', settings.weeklyDateFormat);
  store.set('settings.usageAlerts', settings.usageAlerts);
  store.set('settings.refreshInterval', settings.refreshInterval);
  store.set('settings.graphVisible', settings.graphVisible);
  store.set('settings.expandedOpen', settings.expandedOpen);
  store.set('settings.showTrayStats', settings.showTrayStats);
  // Only when the form actually carries it, so saving settings from a screen
  // that predates the toggle cannot reset the theme.
  if (settings.theme !== undefined) store.set('settings.theme', normaliseTheme(settings.theme));

  // openAtLogin is not supported on Linux — Electron silently ignores it, so
  // autostart is implemented ourselves via the XDG autostart spec instead.
  // Portable builds skip autostart entirely (see isPortable above).
  if (process.platform === 'linux') {
    setLinuxAutostart(autoStart);
  } else if (!isPortable) {
    app.setLoginItemSettings({
      openAtLogin: autoStart,
      ...(process.platform !== 'darwin' && { path: app.getPath('exe') })
    });
  }

  if (mainWindow) {
    if (process.platform === 'darwin') {
      if (settings.minimizeToTray) { app.dock.hide(); } else { app.dock.show(); }
    } else {
      mainWindow.setSkipTaskbar(settings.minimizeToTray);
    }
    mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
  }

  if (!settings.showTrayStats) {
    // Remove tray icons immediately when the setting is turned off from the UI.
    destroyTrayIcons();
  } else {
    // Refresh the tray rollup immediately. When no account has been polled yet
    // this just (re)creates the empty tray icons.
    updateTrayRollup();
  }

  return true;
});

// Shared login-window capture: open a visible BrowserWindow on the provider's
// login page, let the user authenticate normally, and resolve with the auth
// cookie the moment it lands on the account's partition.
//
// Why we don't embed login in the widget itself:
// Claude.ai (via Cloudflare) detects and blocks Electron-embedded logins, and
// ChatGPT works the same way through its own auth stack. We open a standalone
// browser window, let the user authenticate, then capture the auth cookie once
// login completes. Do NOT attempt to "fix" this back to an embedded login
// without verifying the provider no longer blocks it.
//
// SECURITY: Navigation is restricted to the provider + its OAuth IdPs to
// prevent phishing. Popup windows are blocked. The current URL is shown in the
// window title bar for transparency.
// Pending login-capture windows keyed by partition, so cancel-login-capture
// can close a window and detach its cookie listener mid-flow.
const activeLoginCaptures = new Map();

/**
 * Is this URL somewhere a login flow is allowed to go?
 *
 * Rejects anything that is not http(s) FIRST. That matters more than it looks:
 * a custom scheme like `chatgpt://` is how a web page asks the operating system
 * to hand over to an installed desktop app, and a sign-in that jumps out to
 * another app can never deposit its cookie in the partition this widget reads.
 */
function isAllowedLoginUrl(url, allowedLoginDomains) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return { allowed: false, why: 'unparseable URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { allowed: false, why: `non-web scheme ${parsed.protocol}` };
  }
  const host = parsed.hostname;
  const ok = allowedLoginDomains.some((d) => host === d || host.endsWith('.' + d));
  return { allowed: ok, why: ok ? null : `host ${host} is not an allowed login domain` };
}

async function captureLoginCookie({
  partition,
  flow,
  loginUrl,
  titlePrefix,
  cookieSpecs,       // [{ name, domainIncludes, resultKey }]
  allowedLoginDomains
}) {
  const sess = partition ? session.fromPartition(partition) : session.defaultSession;
  if (partition) sess.setUserAgent(CHROME_USER_AGENT);

  // Clear any leftover auth cookies on this account's partition first. Await
  // each removal so Cancel can wait for this operation and restore a reconnect
  // credential only after the destructive work has stopped.
  for (const spec of cookieSpecs) {
    try {
      await sess.cookies.remove(`https://${spec.domainIncludes.replace(/^\./, '')}`, spec.name);
    } catch (_) {}
    if (!isAuthFlowActive(partition, flow)) {
      return { success: false, error: 'Login cancelled' };
    }
  }

  return new Promise((resolve) => {
    const loginWin = new BrowserWindow({
      width: 1000,
      height: 700,
      title: `${titlePrefix} - ${loginUrl}`,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        ...(partition ? { partition } : {})
      }
    });

    let resolved = false;

    // Settle the capture exactly once: detach the cookie listener, unregister
    // from the active-capture registry and resolve the renderer's promise.
    // Idempotent — the window 'closed' event fires after a successful capture
    // AND after cancellation.
    const settle = (result) => {
      if (resolved) return;
      resolved = true;
      sess.cookies.removeListener('changed', onCookieChanged);
      if (flow) flow.controller.signal.removeEventListener('abort', onAbort);
      if (activeLoginCaptures.get(partition)?.loginWin === loginWin) {
        activeLoginCaptures.delete(partition);
      }
      resolve(result);
    };

    const onAbort = () => {
      settle({ success: false, error: 'Login cancelled' });
      try {
        if (!loginWin.isDestroyed()) loginWin.close();
      } catch (_) {}
    };

    // Security: restrict navigation to trusted domains only.
    loginWin.webContents.on('will-navigate', (event, url) => {
      const verdict = isAllowedLoginUrl(url, allowedLoginDomains);
      if (!verdict.allowed) {
        event.preventDefault();
        console.warn(`[Security] Blocked login navigation (${verdict.why}):`, url);
        return;
      }
      // Update title bar to show current URL (read-only)
      loginWin.setTitle(`${titlePrefix} - ${url}`);
    });

    // Update title on OAuth redirects and in-page navigation
    loginWin.webContents.on('did-navigate', (event, url) => {
      loginWin.setTitle(`${titlePrefix} - ${url}`);
    });
    loginWin.webContents.on('did-navigate-in-page', (event, url) => {
      loginWin.setTitle(`${titlePrefix} - ${url}`);
    });

    // Popups are part of the login flow, not an attack on it: the identity
    // providers open one. They are allowed ONLY to allowlisted auth domains,
    // and only on this account's own partition, so a captured cookie lands in
    // the jar the widget actually reads. Anything else is still refused.
    loginWin.webContents.setWindowOpenHandler(({ url }) => {
      const verdict = isAllowedLoginUrl(url, allowedLoginDomains);
      if (!verdict.allowed) {
        console.warn(`[Security] Blocked login popup (${verdict.why}):`, url);
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 560,
          height: 720,
          title: `${titlePrefix} - sign in`,
          autoHideMenuBar: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            ...(partition ? { partition } : {})
          }
        }
      };
    });

    // The popup gets the same navigation policy as its parent, and the same
    // refusal to jump out to another application.
    loginWin.webContents.on('did-create-window', (child) => {
      child.webContents.on('will-navigate', (event, url) => {
        const verdict = isAllowedLoginUrl(url, allowedLoginDomains);
        if (!verdict.allowed) {
          event.preventDefault();
          console.warn(`[Security] Blocked login popup navigation (${verdict.why}):`, url);
        }
      });
      child.webContents.setWindowOpenHandler(({ url }) => {
        const verdict = isAllowedLoginUrl(url, allowedLoginDomains);
        return verdict.allowed ? { action: 'allow' } : { action: 'deny' };
      });
      // A popup that closes on its own is normal - the provider redirects back
      // to the opener and the cookie listener below picks the result up.
    });

    // Resolve as soon as any of the expected auth cookies is set.
    const onCookieChanged = (event, cookie, cause, removed) => {
      const match = cookieSpecs.find((spec) =>
        cookie.name === spec.name &&
        cookie.domain.includes(spec.domainIncludes) &&
        !removed &&
        cookie.value
      );
      if (!match) return;

      settle({ success: true, token: cookie.value, sessionKey: cookie.value, cookieName: cookie.name });
      loginWin.close();
    };

    sess.cookies.on('changed', onCookieChanged);

    loginWin.on('closed', () => {
      if (!resolved) settle({ success: false, error: 'Login window closed' });
    });

    const previous = activeLoginCaptures.get(partition);
    if (previous) {
      previous.settle({ success: false, error: 'Login superseded' });
      try {
        if (!previous.loginWin.isDestroyed()) previous.loginWin.close();
      } catch (_) {}
    }
    activeLoginCaptures.set(partition, { loginWin, settle, flowId: flow?.flowId });
    if (flow) flow.controller.signal.addEventListener('abort', onAbort, { once: true });
    loginWin.loadURL(loginUrl);
  });
}

// Claude login — captures the sessionKey cookie.
ipcMain.handle('detect-session-key', (event, partition, flowId) => {
  const gate = checkLoginAllowed();
  if (!gate.allowed) {
    console.warn(`[Auth] Refused to open a Claude login window: ${gate.reason}`);
    return { success: false, error: gate.error, reason: 'insecure-storage', security: gate.security };
  }
  const flow = beginAuthFlow(partition, flowId);
  return trackAuthOperation(flow, () => captureLoginCookie({
    partition,
    flow,
    loginUrl: 'https://claude.ai/login',
    titlePrefix: 'Claude Login',
    cookieSpecs: [
      { name: 'sessionKey', domainIncludes: 'claude.ai', resultKey: 'sessionKey' }
    ],
    allowedLoginDomains: [
      'claude.ai',
      'accounts.google.com',
      'appleid.apple.com',
      'login.microsoftonline.com'
    ]
  }));
});

// ChatGPT login — captures the __Secure-next-auth.session-token cookie.
ipcMain.handle('detect-chatgpt-token', (event, partition, flowId) => {
  const gate = checkLoginAllowed();
  if (!gate.allowed) {
    console.warn(`[Auth] Refused to open a ChatGPT login window: ${gate.reason}`);
    return { success: false, error: gate.error, reason: 'insecure-storage', security: gate.security };
  }
  const flow = beginAuthFlow(partition, flowId);
  return trackAuthOperation(flow, () => captureLoginCookie({
    partition,
    flow,
    loginUrl: 'https://chatgpt.com/auth/login',
    titlePrefix: 'ChatGPT Login',
    cookieSpecs: [
      { name: '__Secure-next-auth.session-token', domainIncludes: 'chatgpt.com', resultKey: 'token' }
    ],
    allowedLoginDomains: [
      'chatgpt.com',
      'openai.com',          // covers auth.openai.com and auth0.openai.com
      'accounts.google.com',
      'appleid.apple.com',
      'login.microsoftonline.com',
      'login.live.com',      // Microsoft personal accounts
      'challenges.cloudflare.com'  // Turnstile, which ChatGPT's login runs
    ]
  }));
});

// Cancel a pending login capture for a partition: detach its cookie listener
// and close the login window. The renderer calls this when the user cancels
// the add/reconnect flow. When the partition belongs to a SAVED account
// (reconnect), re-assert its stored credential — captureLoginCookie clears
// the partition's auth cookie when the login window opens, so a cancelled
// reconnect must leave the partition exactly as polling expects it.
ipcMain.handle('cancel-login-capture', async (event, partition, flowId) => {
  const flow = authFlowsByPartition.get(partition);
  const matchingFlow = flow && (flowId === undefined || flowId === null || flow.flowId === flowId)
    ? flow
    : null;
  // Capture this before aborting: AbortController listeners settle the login
  // promise synchronously and remove its window from the registry.
  const capture = activeLoginCaptures.get(partition);
  const matchingCapture = capture && (flowId === undefined || flowId === null || capture.flowId === flowId)
    ? capture
    : null;
  if (matchingFlow) {
    matchingFlow.cancelled = true;
    matchingFlow.controller.abort();
  }

  if (matchingCapture) {
    matchingCapture.settle({ success: false, error: 'Login cancelled' });
    try {
      if (!matchingCapture.loginWin.isDestroyed()) matchingCapture.loginWin.close();
    } catch (_) {}
  }

  if (matchingFlow) await Promise.allSettled([...matchingFlow.pending]);
  // A stale Cancel from an older renderer flow must not overwrite a newer
  // login on the same partition with the saved credential.
  if ((flowId === undefined || flowId === null)
      || (matchingFlow && authFlowsByPartition.get(partition) === matchingFlow)) {
    await restoreSavedCredential(partition);
  }
  return !!matchingCapture;
});

// Check GitHub releases for a newer version
ipcMain.handle('check-for-update', () => {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      method: 'GET',
      headers: {
        'User-Agent': 'ai-usage-monitor',
        'Accept': 'application/vnd.github+json'
      },
      timeout: 5000
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        // Compared against the APP's version, not app.getVersion() - which
        // returns the Electron runtime version when Electron was started
        // without an app directory, and would have made every release look
        // older than 44.x. The parser fails closed on an empty, HTML,
        // truncated, rate-limited or tag-less response; see
        // src/version-compare.js.
        const decision = parseReleaseResponse(body, APP_VERSION);
        if (!decision.hasUpdate) debugLog('[Update] No update offered:', decision.reason);
        resolve({ hasUpdate: decision.hasUpdate, version: decision.version });
      });
    });

    req.on('error', () => resolve({ hasUpdate: false, version: null }));
    req.on('timeout', () => { req.destroy(); resolve({ hasUpdate: false, version: null }); });
    req.end();
  });
});

// The version comparison and the response parsing now live in
// src/version-compare.js so both can be checked offline, including the
// responses that must NOT be reported as a release.

// Flag an account as session-expired: drop its key, forget its latest data,
// tell the renderer so only that card flips to "Reconnect". Other accounts
// keep polling.
//
// Reached ONLY on positive proof that a credential is dead — currently just
// ChatGPT's AuthRequired. A failed read is not proof (see
// handleProviderError / isTransientReadError), because deleting a working
// credential over a Cloudflare challenge costs the user their login for no
// reason.
/**
 * Delete the credential a read has just proved dead, and tell the renderer.
 *
 * `expectedKey` is the credential the read actually authenticated with. A
 * deletion only applies to THAT credential: if the store now holds a different
 * one, a reconnect replaced it while the read was in flight and the rejection
 * belongs to a secret that is already gone. Generation checks answer the same
 * question most of the time, but they are a counter - this compares the thing
 * itself, so no ordering of save, read and commit can make a proven-dead OLD
 * credential delete a live NEW one.
 *
 * @returns {boolean} whether the credential was deleted
 */
function markAccountExpired(accountId, expectedKey) {
  if (expectedKey !== undefined) {
    const current = loadAccountKey(accountId);
    if (current !== expectedKey) {
      debugLog(`[Usage] Account ${accountId}: the rejected credential is no longer the stored one - keeping what is there`);
      return false;
    }
  }
  deleteAccountKey(accountId);
  delete usageStateByAccount[accountId];
  if (mainWindow) {
    mainWindow.webContents.send('account-session-expired', accountId);
  }
  updateTrayRollup();
  return true;
}

// A Cloudflare interstitial, a JS/cookie challenge page or an unexpected HTML
// body (see BLOCKED_SIGNATURES in src/fetch-via-window.js) is recognised from
// the RESPONSE BODY. It says the read did not return JSON — nothing more. The
// credential may be perfectly good and usually is: a challenge is exactly what
// Cloudflare serves to a valid session it wants to re-verify.
//
// These used to be treated as proof that the Claude login was dead, so a
// single challenge deleted the saved credential and forced the reconnect flow.
// They are transient read failures: the reading goes stale (or unavailable, if
// there has never been a good one), the credential is kept, and the next
// successful response recovers on its own.
// Kept as a named function so the reasoning above stays attached to it, but
// the list itself now lives in src/read-errors.js, shared with the provider
// reader and covered by its own unit tests.
const { isTransientReadError, isConfirmedAuthRejection } = require('./src/read-errors');

// Auto-read failed. A credential is only discarded on POSITIVE proof that it
// is dead, and the only such signal either provider gives us is ChatGPT's
// AuthRequired — no token could be minted at all. Claude's reader has no
// equivalent: it classifies body text, so it cannot distinguish "your session
// expired" from "Cloudflare wants a challenge solved". Nothing else — a
// challenge, an HTML page, a 403, a timeout — is treated as auth expiry.
//
// Everything that is not proven-dead falls back to the account's manual entry
// when one is configured, and otherwise returns null so the caller keeps the
// previous reading marked stale (or reports unavailable).
async function handleProviderError(account, error, generation, credentialKey) {
  debugLog(`Usage fetch failed for account ${account.id} (${account.provider}):`, error.message);

  // ChatGPT only, and only for a genuine rejection. A failure to obtain a
  // token from the session-exchange endpoint (network error, HTML, 5xx,
  // unparseable JSON) is reported by the reader as SessionExchangeUnavailable
  // and is NOT this. See src/read-errors.js.
  const authDead = isConfirmedAuthRejection(account.provider, error);

  if (authDead) {
    // Only delete a credential if this read still owns the account. A read
    // that started before a reconnect (or before a removal) must not delete
    // what happened since.
    if (generation !== undefined && !isAccountCurrent(account.id, generation)) {
      debugLog(`[Usage] Account ${account.id}: discarding a stale auth rejection from a superseded read`);
      throw new Error(STALE_READ);
    }
    // Second, independent guard: delete only the credential this read used.
    if (!markAccountExpired(account.id, credentialKey)) {
      throw new Error(STALE_READ);
    }
    throw new Error('SessionExpired');
  }

  if (isTransientReadError(error)) {
    debugLog(`[Usage] Account ${account.id}: ${error.message.split(':')[0]} is a transient read failure — credential kept`);
  }

  const manual = account.manual;
  if (manual && manual.limit > 0) {
    debugLog(`[Usage] Auto-read failed for account ${account.id}, using manual entry`);
    return manualUsageData(manual, { provider: account.provider, degraded: true });
  }
  // No fallback available. The caller records the account as unavailable (or
  // keeps its previous reading, marked stale) instead of throwing, so a failed
  // refresh can never leave old values looking current.
  return null;
}

// Claude usage fetch: the /api/organizations/{orgId}/usage endpoint behind the
// account's own partition (bypasses Cloudflare), normalized to the shared
// rows shape (see src/providers.js).
async function fetchClaudeUsage(account) {
  const organizationId = account.orgId;
  const usageUrl = `https://claude.ai/api/organizations/${organizationId}/usage`;

  const results = await fetchMultipleViaWindow([usageUrl], { partition: partitionFor(account.id) });
  return normalizeClaudeUsage(results[0]);
}

// ChatGPT usage fetch: wham/usage read through the account's partition
// (see src/providers.js).
async function fetchChatGPTUsage(account) {
  return fetchChatGPTUsageData({ partition: partitionFor(account.id) });
}

// Re-assert always-on-top after hidden BrowserWindows from fetchViaWindow are
// destroyed — creating/destroying BrowserWindows can temporarily disrupt the
// main window's z-order on some OS/window manager combinations.
function reassertAlwaysOnTop() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (store.get('settings.alwaysOnTop', true)) {
    mainWindow.setAlwaysOnTop(true, 'floating');
  }
}

// Read one account's usage. Always resolves with a status payload — the only
// throws are UnknownAccount and SessionExpired, the latter keeping the existing
// reconnect flow exactly as it was.
ipcMain.handle('fetch-usage-data', async (event, accountId) => {
  const account = getAccount(accountId);
  if (!account) throw new Error('UnknownAccount');

  // The generation this read belongs to. Every await below is followed by a
  // check: if the account was removed, re-authenticated or switched to manual
  // in the meantime, this read abandons itself instead of writing state,
  // history or a credential deletion for an account that no longer matches.
  const generation = accountGenerationOf(accountId);
  const stillOurs = () => isAccountCurrent(accountId, generation);

  const manual = account.manual;
  const manualOnly = manual && manual.enabled && manual.limit > 0;

  if (manualOnly) {
    // Manual override enabled — skip the auto-read entirely. The user's own
    // number is not an automatic reading, so lastSuccessAt does not move.
    const data = recordUsageSuccess(
      accountId,
      manualUsageData(manual, { provider: account.provider }),
      { automatic: false }
    );
    storeUsageHistory(accountId, data);
    updateTrayRollup();
    return data;
  }

  // Why the credential state matters here: "there is no credential" and "the
  // credential is there but the keychain will not open it" need different
  // answers. The first is fixed by connecting; the second is not fixed by
  // anything the user can do in this app, and offering Reconnect for it would
  // be a lie — reconnecting cannot unlock a keychain.
  const credential = loadAccountCredential(accountId);
  if (!credential.key) {
    const keychainProblem = isKeychainProblem(credential.mode);
    const error = keychainProblem
      ? new Error(`SecureStorageLocked: ${credential.mode}`)
      : new Error('Missing credentials');

    // A manual entry (not overridden) can still power the card, but only as a
    // clearly-marked fallback.
    if (manual && manual.limit > 0) {
      const data = recordUsageFallback(
        accountId,
        manualUsageData(manual, { provider: account.provider, degraded: true }),
        error
      );
      updateTrayRollup();
      return data;
    }
    const data = recordUsageFailure(accountId, error);
    updateTrayRollup();
    return data;
  }

  // Ensure the cookie is present on this account's partition.
  await setSessionCookie(credential.key, accountId, account.provider);
  if (!stillOurs()) throw new Error(STALE_READ);

  let fresh;
  try {
    if (account.provider === 'chatgpt') {
      fresh = await fetchChatGPTUsage(account);
    } else {
      if (!account.orgId) throw new Error('Missing credentials');
      fresh = await fetchClaudeUsage(account);
    }
  } catch (error) {
    if (!stillOurs()) throw new Error(STALE_READ);
    // Throws SessionExpired for a proven-dead credential (and StaleRead if the
    // account moved on underneath it); otherwise a manual fallback or null.
    const fallback = await handleProviderError(account, error, generation, credential.key);
    if (!stillOurs()) throw new Error(STALE_READ);
    const data = fallback
      ? recordUsageFallback(accountId, fallback, error)
      : recordUsageFailure(accountId, error);
    updateTrayRollup();
    reassertAlwaysOnTop();
    return data;
  }

  if (!stillOurs()) throw new Error(STALE_READ);

  // A response that carries no usable reading is not a success: keep the
  // previous values marked stale rather than publishing fabricated zeroes.
  if (!hasAnyReading(fresh.rows)) {
    const data = recordUsageFailure(accountId, new Error('NoUsableReading'));
    updateTrayRollup();
    reassertAlwaysOnTop();
    return data;
  }

  const data = recordUsageSuccess(accountId, fresh, { automatic: true });
  storeUsageHistory(accountId, data);
  updateTrayRollup();
  reassertAlwaysOnTop();
  return data;
});

// ---------------------------------------------------------------------------
// Linux desktop integration (icon, taskbar pinning, autostart)
//
// StartupWMClass must equal the real WM_CLASS the packaged app reports — this
// value is package.json's build.linux.desktop.entry.StartupWMClass guess
// (productName). VERIFY with `xprop WM_CLASS` on the built app before release
// and update both places together if it's wrong.
// ---------------------------------------------------------------------------
const LINUX_WM_CLASS = 'AI-Usage-Monitor';
const LINUX_ICON_NAME = 'claude-usage-widget';
const LINUX_DESKTOP_ENTRY_NAME = 'claude-usage-widget.desktop';

function linuxExecPath() {
  return process.env.APPIMAGE || process.execPath;
}

function buildLinuxDesktopEntry(execPath, autostart) {
  const lines = [
    '[Desktop Entry]',
    'Name=AI Usage Monitor',
    'Comment=Monitor Claude.ai usage across accounts',
    `Exec="${execPath}" %U`,
    `Icon=${LINUX_ICON_NAME}`,
    `StartupWMClass=${LINUX_WM_CLASS}`,
    'Terminal=false',
    'Type=Application',
    'Categories=Utility;'
  ];
  if (autostart) lines.push('X-GNOME-Autostart-enabled=true');
  return lines.join('\n') + '\n';
}

// AppImages aren't installed via a package manager, so no .desktop file exists
// in ~/.local/share/applications for the window manager to match the running
// window against — without one there's no correct taskbar icon and nothing to
// pin. This writes the icon + a .desktop entry once per AppImage path (skip
// silently on any error; .deb installs get this for free from electron-builder).
function ensureLinuxDesktopIntegration() {
  if (process.platform !== 'linux' || !process.env.APPIMAGE) return;

  try {
    // Derived from app.getPath('home') (and $XDG_DATA_HOME) rather than
    // os.homedir(), so a test profile that redirects Electron's home path is
    // genuinely isolated instead of writing into the developer's own
    // ~/.local/share. Production resolves to exactly the same place.
    const { appsDir, iconDir } = linuxDesktopDirs({ env: process.env, home: app.getPath('home') });
    fs.mkdirSync(iconDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'assets/icons/512x512.png'), path.join(iconDir, `${LINUX_ICON_NAME}.png`));

    const desktopPath = path.join(appsDir, LINUX_DESKTOP_ENTRY_NAME);
    const execPath = linuxExecPath();

    // Rewrite only if missing or pointing at a stale AppImage path (moved/updated).
    const upToDate = fs.existsSync(desktopPath) && fs.readFileSync(desktopPath, 'utf-8').includes(`Exec="${execPath}"`);
    if (!upToDate) {
      fs.mkdirSync(appsDir, { recursive: true });
      fs.writeFileSync(desktopPath, buildLinuxDesktopEntry(execPath, false));
      execFile('update-desktop-database', [appsDir], () => {}); // best-effort, ignore failure
    }
  } catch (err) {
    debugLog('[Linux] Desktop integration skipped:', err.message);
  }
}

// Electron's setLoginItemSettings is a no-op on Linux, so autostart is
// implemented directly via the XDG autostart spec (~/.config/autostart).
function setLinuxAutostart(enabled) {
  try {
    // app.getPath('appData') is $XDG_CONFIG_HOME (or ~/.config) on Linux,
    // which is where the autostart spec puts this file - and it is
    // redirectable, so an isolated run cannot register the real user's
    // session for autostart.
    const autostartDir = linuxAutostartDir({ appData: app.getPath('appData') });
    const desktopPath = path.join(autostartDir, LINUX_DESKTOP_ENTRY_NAME);
    if (enabled) {
      fs.mkdirSync(autostartDir, { recursive: true });
      fs.writeFileSync(desktopPath, buildLinuxDesktopEntry(linuxExecPath(), true));
    } else if (fs.existsSync(desktopPath)) {
      fs.unlinkSync(desktopPath);
    }
  } catch (err) {
    debugLog('[Linux] Autostart toggle failed:', err.message);
  }
}

// Smoke-test hook (opt-in via SMOKE_SCREENSHOT env var): after a few seconds
// capture the renderer to a PNG, dump any renderer console messages and a
// DOM-state summary, then quit. Lets CI / developers verify the UI boots
// without manual inspection. Never active in normal use.
if (process.env.SMOKE_SCREENSHOT) {
  // A packaged Windows application is built for the "windows" subsystem, so it
  // has no console attached and console.log goes nowhere. SMOKE_LOG gives the
  // hook a file to write to instead, which is what makes the same hook usable
  // against a real package rather than only against `electron .`.
  const smokeLogPath = process.env.SMOKE_LOG || null;
  const smokeOutDir = process.env.SMOKE_OUT || process.cwd();
  const smokeLog = (...parts) => {
    const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    console.log(line);
    if (smokeLogPath) {
      try { fs.appendFileSync(smokeLogPath, line + '\n'); } catch (_) {}
    }
  };

  smokeLog('[Smoke] hook installed:', JSON.stringify({
    delayMs: parseInt(process.env.SMOKE_SCREENSHOT, 10) || 8000,
    outDir: smokeOutDir,
    lifecycle: process.env.SMOKE_LIFECYCLE === '1',
    pid: process.pid
  }));

  // ── Network containment, installed before the app is ready ──────────────
  //
  // A packaged application cannot have mocks injected from outside: its code
  // is inside app.asar. So the containment lives here, in the same opt-in hook,
  // and it covers BOTH stacks the app can reach the network with - which is the
  // gap this used to have, because only one of them is Chromium's:
  //
  //   * Chromium: every provider read, every login window and anything the
  //     renderer fetches. Blocked per session, including partition sessions
  //     created later, and every attempt is counted.
  //   * Node: the update check is a plain https.request to api.github.com from
  //     the main process (see check-for-update). No session filter can see it,
  //     so the handler itself is replaced with a local answer. The renderer
  //     schedules that check about two seconds after it loads, which is well
  //     inside a smoke run, so leaving it alone meant a real outbound request
  //     during a test that claimed to make none.
  const smokeBlocked = [];
  const smokeBlockSession = (ses) => {
    try {
      ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
        smokeBlocked.push(details.url);
        callback({ cancel: true });
      });
    } catch (err) {
      smokeLog('[Smoke] could not install the request blocker:', String(err && err.message));
    }
  };
  app.on('session-created', smokeBlockSession);
  app.whenReady().then(() => smokeBlockSession(session.defaultSession));

  let smokeUpdateChecks = 0;
  app.whenReady().then(() => {
    try {
      ipcMain.removeHandler('check-for-update');
      ipcMain.handle('check-for-update', () => {
        smokeUpdateChecks += 1;
        return { hasUpdate: false, smokeAnswered: true };
      });
      smokeLog('[Smoke] update check answered locally (no outbound https)');
    } catch (err) {
      smokeLog('[Smoke] could not replace the update check:', String(err && err.message));
    }
  });

  app.on('web-contents-created', (event, contents) => {
    contents.on('console-message', (...args) => {
      // Electron 35 moved this event's payload into the event object:
      //   <= 34   (event, level, message, line, sourceId)
      //   >= 35   (event) with event.message / event.level / event.lineNumber
      // Reading both shapes keeps the smoke hook working either side of the
      // runtime upgrade instead of silently logging "undefined".
      const legacy = typeof args[2] === 'string';
      const message = legacy ? args[2] : (args[0] && args[0].message);
      smokeLog('[Smoke][renderer]', String(message));
    });
  });

  app.whenReady().then(() => smokeLog('[Smoke] app ready'));

  const delayMs = parseInt(process.env.SMOKE_SCREENSHOT, 10) || 8000;

  // A watchdog, because a hook that hangs reports nothing at all. The macOS
  // packaged run stopped after "app ready" and was still alive when the
  // launcher gave up 90 seconds later, so the only evidence was a timeout.
  // This fires well before any launcher timeout, says what the hook had
  // reached, and leaves - so a hang becomes a legible failure rather than a
  // stalled job.
  let smokeStage = 'waiting for the capture delay';
  const smokeWatchdog = setTimeout(() => {
    smokeLog('[Smoke] WATCHDOG: giving up while ' + smokeStage
      + ' — ' + JSON.stringify({
        hasWindow: !!(mainWindow && !mainWindow.isDestroyed()),
        windows: BrowserWindow.getAllWindows().length,
        ready: app.isReady()
      }));
    app.exit(75);
  }, delayMs + 45000);
  if (smokeWatchdog.unref) smokeWatchdog.unref();

  setTimeout(async () => {
    smokeStage = 'writing the identity record';
    // Identity facts the packaged smoke asserts: the version must be the APP's
    // (not the Electron runtime's) and the profile must be the one the launcher
    // pointed at. Written BEFORE the capture, so a capture that fails still
    // leaves the identity evidence behind.
    smokeLog('[Smoke] identity:', JSON.stringify({
      appVersion: APP_VERSION,
      electron: process.versions.electron,
      configPath,
      configHealth: configHealth.state,
      packaged: app.isPackaged,
      hasWindow: !!(mainWindow && !mainWindow.isDestroyed())
    }));
    clearTimeout(smokeWatchdog);
    smokeStage = 'running the lifecycle checks';
    // ── The real IPC seam, exercised inside the packaged process ─────────
    //
    // Opt-in with SMOKE_LIFECYCLE=1. Everything below runs in the SHIPPED
    // renderer through the SHIPPED preload, so it exercises contextBridge, the
    // IPC channel names and the main-process handlers exactly as a user's
    // click does. A DOM screenshot proves the window painted; it proves
    // nothing about whether account creation, validation, removal or the
    // credential rules work inside a package, which is what this covers.
    if (process.env.SMOKE_LIFECYCLE === '1' && mainWindow && !mainWindow.isDestroyed()) {
      try {
        const lifecycle = await mainWindow.webContents.executeJavaScript(`(async () => {
          const api = window.electronAPI;
          const out = { steps: [] };
          const step = (name, value) => { out.steps.push(name); out[name] = value; };

          step('secureStorage', await api.getSecureStorage());
          step('configHealth', await api.getConfigHealth());
          step('accountsAtStart', (await api.getAccounts()).map((a) => ({
            id: a.id, provider: a.provider, hasSession: a.hasSession,
            credentialState: a.credentialState, manual: !!a.manual
          })));

          const draft = await api.createDraftAccount();
          step('draft', { id: draft.id, partition: draft.partition });

          const created = await api.createManualAccount({
            id: draft.id, label: 'Lifecycle', provider: 'chatgpt',
            manual: { enabled: true, used: 30, limit: 60 }
          });
          step('created', created);

          const invalid = await api.saveAccountManual(draft.id, { enabled: true, used: -1, limit: 0 });
          step('invalidRefused', invalid);

          const valid = await api.saveAccountManual(draft.id, { enabled: true, used: 15, limit: 60 });
          step('validAccepted', valid);

          const read = await api.fetchUsageData(draft.id).then(
            (d) => ({ status: d.status, source: d.source, rows: (d.rows || []).map((r) => r.utilization) }),
            (e) => ({ error: String(e.message) })
          );
          step('manualRead', read);

          step('accountsAfterCreate', (await api.getAccounts()).map((a) => a.id));
          step('removal', await api.removeAccount(draft.id));
          step('accountsAfterRemoval', (await api.getAccounts()).map((a) => a.id));
          return out;
        })()`);
        smokeLog('[Smoke] lifecycle:', JSON.stringify(lifecycle, null, 2));
      } catch (err) {
        smokeLog('[Smoke] lifecycle failed:', String(err && err.stack || err));
      }
    }

    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const summary = await mainWindow.webContents.executeJavaScript(`({
          title: document.title,
          accountCards: document.querySelectorAll('.account-block').length,
          sessionRows: document.querySelectorAll('.session-row').length,
          weeklyRows: document.querySelectorAll('.weekly-row').length,
          statusColors: [...document.querySelectorAll('.row-bar-fill')].map(el => getComputedStyle(el).backgroundColor),
          pctTexts: [...document.querySelectorAll('.row-pct')].map(el => el.textContent),
          providerTags: [...document.querySelectorAll('.account-provider-tag')].map(el => el.textContent),
          bodyText: (document.body.innerText || '').slice(0, 300)
        })`);
        smokeLog('[Smoke] DOM summary:', JSON.stringify(summary, null, 2));

        const image = await mainWindow.webContents.capturePage();
        const target = path.join(smokeOutDir, 'smoke-screenshot.png');
        fs.writeFileSync(target, image.toPNG());
        smokeLog('[Smoke] Screenshot saved to', target);
      }
    } catch (err) {
      smokeLog('[Smoke] capture failed:', String(err && err.message));
    }
    // What the containment actually caught, so the launcher can assert on it
    // rather than assume it worked.
    smokeLog('[Smoke] network:', JSON.stringify({
      blockedRequests: smokeBlocked.length,
      blockedHosts: [...new Set(smokeBlocked.map((url) => {
        try { return new URL(url).host; } catch (err) { return 'unparseable'; }
      }))],
      updateChecksAnsweredLocally: smokeUpdateChecks
    }));
    // app.exit, not app.quit: this is a test-only hook and it must not be
    // possible for a window handler to keep the process alive and turn a
    // packaged smoke run into a timeout.
    app.exit(0);
  }, delayMs);
}

// App lifecycle
app.whenReady().then(async () => {
  // History housekeeping: fold the single-key legacy history into the per-org key
  // (still keyed off any legacy organizationId, before migrateLegacyAccount deletes it).
  migrateUsageHistoryKey();

  // Fold any legacy single-account config into accounts[0], then restore each
  // account's sessionKey cookie onto its own partition.
  migrateLegacyAccount();

  // Now that accounts[] is populated, rename any per-org history key to the
  // per-account key, then prune whatever's left (stale/orphaned or aged-out).
  migrateUsageHistoryKeysToAccounts();
  pruneStaleHistoryKeys();

  for (const account of getAccounts()) {
    const key = loadAccountKey(account.id);
    if (key) {
      try {
        await setSessionCookie(key, account.id, account.provider);
      } catch (err) {
        // One account's partition refusing its cookie must not stop the app
        // starting, and must not stop the other accounts being restored.
        console.error(`[Startup] Could not restore the session cookie for account ${account.id}: ${err.message}`);
      }
    }
  }

  createMainWindow();
  ensureLinuxDesktopIntegration();
  // Avoid creating temporary tray icons during startup when tray stats are disabled.
  if (store.get('settings.showTrayStats', false)) {
    createTray();
  }

  // Apply persisted settings
  const minimizeToTray = store.get('settings.minimizeToTray', false);
  const alwaysOnTop = store.get('settings.alwaysOnTop', true);
  if (mainWindow) {
    if (process.platform === 'darwin') {
      if (minimizeToTray) app.dock.hide();
    } else {
      if (minimizeToTray) mainWindow.setSkipTaskbar(true);
    }
    mainWindow.setAlwaysOnTop(alwaysOnTop, 'floating');
  }

  // Periodic always-on-top re-assertion to recover from z-order disruptions
  // (hidden window spawns, window manager shortcuts, alt-tab, etc.)
  setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const alwaysOnTopSetting = store.get('settings.alwaysOnTop', true);
      if (alwaysOnTopSetting) {
        mainWindow.setAlwaysOnTop(true, 'floating');
      }
    }
  }, 5000);
});

app.on('window-all-closed', () => {
  // Keep running in tray — but only if a tray icon actually exists to restore
  // from. With showTrayStats off there is no tray, so an OS-level window close
  // (Alt+F4, WM close) would otherwise leave a headless process with no way
  // to reopen it.
  const hasTray = sessionTray && !sessionTray.isDestroyed();
  if (!hasTray) app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createMainWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
