// Where a login flow is allowed to go.
//
// WHY THIS EXISTS. ChatGPT could not be connected at all. Its sign-in page
// offers "Continue with Google", "Continue with Apple" and "Continue with
// phone", and every one of those opens a POPUP - while the login window denied
// every popup outright. Claude worked because its email form navigates in
// place, so the defect looked like "ChatGPT is broken" rather than "popups are
// blocked".
//
// The fix allows popups, which means the navigation policy is now the only
// thing standing between a login window and anywhere else. So it is tested
// directly, on the real function lifted out of main.js.
//
// The scheme check is the part that matters most and is easiest to lose: a
// custom scheme like `chatgpt://` is how a web page asks Windows to hand over
// to an INSTALLED DESKTOP APP. A sign-in that jumps out to another application
// can never deposit its cookie in the partition this widget reads, so it is not
// a login - it is a dead end that looks like one.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function liftGuard() {
  const start = source.indexOf('function isAllowedLoginUrl(');
  assert.ok(start >= 0, 'isAllowedLoginUrl not found in main.js');
  const end = source.indexOf('async function captureLoginCookie(', start);
  assert.ok(end > start, 'could not find the end of the guard');
  const sandbox = { URL, console };
  vm.runInNewContext(source.slice(start, end) + '\nthis.isAllowedLoginUrl = isAllowedLoginUrl;', sandbox);
  return sandbox.isAllowedLoginUrl;
}

const isAllowedLoginUrl = liftGuard();

// The two allowlists the app actually passes, read from main.js rather than
// retyped, so a domain removed there fails here.
function allowlistFor(handler) {
  const at = source.indexOf(`ipcMain.handle('${handler}'`);
  assert.ok(at >= 0, `${handler} handler not found`);
  const block = source.slice(at, source.indexOf('});', at));
  const list = /allowedLoginDomains:\s*\[([\s\S]*?)\]/.exec(block);
  assert.ok(list, `${handler} has no allowedLoginDomains`);
  return list[1]
    .split(',')
    .map((s) => s.replace(/\/\/.*$/gm, '').trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

const CHATGPT = allowlistFor('detect-chatgpt-token');
const CLAUDE = allowlistFor('detect-session-key');

function testChatGPTAuthDomainsAreReachable() {
  const mustReach = [
    'https://chatgpt.com/auth/login',
    'https://auth.openai.com/authorize?client_id=x',
    'https://auth0.openai.com/u/login/identifier',
    'https://accounts.google.com/o/oauth2/v2/auth?scope=email',
    'https://appleid.apple.com/auth/authorize',
    'https://challenges.cloudflare.com/turnstile/v0/api.js'
  ];
  for (const url of mustReach) {
    const v = isAllowedLoginUrl(url, CHATGPT);
    assert.strictEqual(v.allowed, true, `ChatGPT login must be able to reach ${url} (${v.why})`);
  }
}

function testClaudeAuthDomainsAreReachable() {
  for (const url of ['https://claude.ai/login', 'https://accounts.google.com/o/oauth2/v2/auth']) {
    const v = isAllowedLoginUrl(url, CLAUDE);
    assert.strictEqual(v.allowed, true, `Claude login must be able to reach ${url} (${v.why})`);
  }
}

// THE REGRESSION. A desktop-app handoff is not a login.
function testDesktopAppHandoffIsRefused() {
  for (const url of ['chatgpt://open', 'ms-chatgpt://launch', 'openai://chat', 'claude://open']) {
    const v = isAllowedLoginUrl(url, CHATGPT);
    assert.strictEqual(v.allowed, false, `${url} must never be followed`);
    assert.match(v.why, /non-web scheme/, `${url} must be refused for its scheme`);
  }
}

function testLocalAndScriptSchemesAreRefused() {
  for (const url of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'data:text/html,<h1>x']) {
    assert.strictEqual(isAllowedLoginUrl(url, CHATGPT).allowed, false, `${url} must be refused`);
  }
}

function testLookalikeAndForeignHostsAreRefused() {
  const refuse = [
    'https://chatgpt.com.evil.com/login',   // suffix attack
    'https://notchatgpt.com/login',
    'https://evil.com/?next=chatgpt.com',
    'https://openai.com.attacker.net/'
  ];
  for (const url of refuse) {
    assert.strictEqual(isAllowedLoginUrl(url, CHATGPT).allowed, false, `${url} must be refused`);
  }
}

function testSubdomainsOfAllowedHostsAreReachable() {
  // endsWith('.' + domain) - a real subdomain, not a suffix match on the bare name.
  assert.strictEqual(isAllowedLoginUrl('https://auth.openai.com/x', CHATGPT).allowed, true);
  assert.strictEqual(isAllowedLoginUrl('https://xopenai.com/x', CHATGPT).allowed, false);
}

function testGarbageIsRefusedRatherThanThrowing() {
  for (const url of ['not a url', '', '///', null, undefined]) {
    const v = isAllowedLoginUrl(url, CHATGPT);
    assert.strictEqual(v.allowed, false, `${JSON.stringify(url)} must be refused`);
  }
}

// The popup handler must exist and must consult the guard - denying every popup
// is what broke ChatGPT in the first place.
function testPopupsAreAllowedThroughTheSameGuard() {
  assert.ok(/setWindowOpenHandler\(\(\{ url \}\) => \{/.test(source),
    'the login window must inspect the popup URL, not refuse blindly');
  assert.ok(/action: 'allow'/.test(source),
    'THE REGRESSION - allowlisted auth popups must be permitted');
  const handler = source.slice(source.indexOf('setWindowOpenHandler(({ url }) => {'));
  assert.ok(handler.indexOf('isAllowedLoginUrl') < handler.indexOf("action: 'allow'"),
    'the popup must be checked against the guard before it is allowed');
  assert.ok(/did-create-window/.test(source),
    'a popup must inherit the same navigation policy as its parent');
}

const tests = [
  testChatGPTAuthDomainsAreReachable,
  testClaudeAuthDomainsAreReachable,
  testDesktopAppHandoffIsRefused,
  testLocalAndScriptSchemesAreRefused,
  testLookalikeAndForeignHostsAreRefused,
  testSubdomainsOfAllowedHostsAreReachable,
  testGarbageIsRefusedRatherThanThrowing,
  testPopupsAreAllowedThroughTheSameGuard
];

let failed = 0;
for (const t of tests) {
  try {
    t();
    console.log(`PASS  ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${t.name}\n      ${err.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} login-navigation test groups passed`);
if (failed) process.exit(1);
