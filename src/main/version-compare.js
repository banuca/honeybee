/**
 * version-compare.js
 *
 * Deciding whether a release the update check found is actually newer, and
 * turning a GitHub release response into that decision.
 *
 * Extracted from main.js so both halves can be checked offline: the version
 * comparison and, just as importantly, what happens to a response that is
 * empty, HTML, truncated, rate-limited or simply missing a tag. The network
 * call itself stays in main.js — bounded, and failing closed.
 *
 * The notification is only ever a notification: nothing here downloads or
 * replaces a binary.
 */
'use strict';

function parseVersion(ver) {
  const [mainVer, preRelease] = String(ver).split('-');
  const parts = mainVer.split('.').map(Number);
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
    preRelease: preRelease || null
  };
}

/**
 * Is `remote` a stable release newer than `local`?
 *
 * Pre-releases are never announced. The one case where equal numbers still
 * count as newer is a local pre-release against the matching stable release
 * (1.7.5-rc.1 → 1.7.5).
 */
function isNewerVersion(remote, local) {
  try {
    const r = parseVersion(remote);
    const l = parseVersion(local);
    if (r.preRelease !== null) return false;
    if (r.major !== l.major) return r.major > l.major;
    if (r.minor !== l.minor) return r.minor > l.minor;
    if (r.patch !== l.patch) return r.patch > l.patch;
    return l.preRelease !== null;
  } catch (err) {
    return false;
  }
}

/**
 * Turn a releases/latest response body into an update decision.
 *
 * Fails closed on anything it does not understand: no update, no version, and
 * a reason the caller can log. A rate-limit message, an HTML error page or a
 * truncated body must never be reported to the user as a release.
 *
 * @param {string} body            the raw response body
 * @param {string} currentVersion  the APP's version (never the runtime's)
 * @returns {{hasUpdate: boolean, version: string|null, reason: string}}
 */
function parseReleaseResponse(body, currentVersion) {
  if (typeof body !== 'string' || body.trim() === '') {
    return { hasUpdate: false, version: null, reason: 'empty-response' };
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    return { hasUpdate: false, version: null, reason: 'unparseable-response' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { hasUpdate: false, version: null, reason: 'unexpected-response-shape' };
  }
  if (typeof data.message === 'string' && !data.tag_name) {
    // GitHub's error shape: rate limiting, a missing repository, and so on.
    return { hasUpdate: false, version: null, reason: `api-message:${data.message.slice(0, 60)}` };
  }
  if (data.draft === true || data.prerelease === true) {
    return { hasUpdate: false, version: null, reason: 'draft-or-prerelease' };
  }
  const tag = String(data.tag_name || '').replace(/^v/, '').trim();
  if (!tag) return { hasUpdate: false, version: null, reason: 'no-tag' };
  if (!/^\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?$/.test(tag)) {
    return { hasUpdate: false, version: null, reason: `unrecognised-tag:${tag.slice(0, 32)}` };
  }
  if (!isNewerVersion(tag, currentVersion)) {
    return { hasUpdate: false, version: null, reason: 'not-newer' };
  }
  return { hasUpdate: true, version: tag, reason: 'newer-stable-release' };
}

// Where the notification sends the user: the project's own releases page, so
// they choose the artifact for their platform themselves.
function releasesUrlFor(owner, repo) {
  return `https://github.com/${owner}/${repo}/releases/latest`;
}

module.exports = { parseVersion, isNewerVersion, parseReleaseResponse, releasesUrlFor };
