'use strict';

// A tiny test runner: register tests, run them in order, exit non-zero on any
// failure. No framework, so `npm test` needs nothing beyond Node.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run(suite) {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  pass  ${t.name}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL  ${t.name}\n        ${String(err && err.stack || err).split('\n').slice(0, 6).join('\n        ')}`);
    }
  }
  console.log(`${suite}: ${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exitCode = 1;
}

function tempDir(prefix = 'honeybee-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A clock the test moves by hand.
function clock(start = Date.UTC(2026, 9, 1, 12, 0, 0)) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; return t; };
  now.set = (ms) => { t = ms; return t; };
  return now;
}

module.exports = { test, run, tempDir, clock };
