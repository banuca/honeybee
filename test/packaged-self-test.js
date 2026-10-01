'use strict';

// Launch a packaged build for real on a throwaway profile and check its own
// report: the window rendered, the local server answered, the bubble showed.
//
//   node test/packaged-self-test.js <path to the packaged executable>

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) {
  console.error(`no executable at ${exe}`);
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'honeybee-packaged-'));
const resultFile = path.join(root, 'result.json');
fs.mkdirSync(path.join(root, 'home'), { recursive: true });

const env = { ...process.env, HONEYBEE_HOME: path.join(root, 'home'), HONEYBEE_USER_DATA: path.join(root, 'userData'), HONEYBEE_PORT: '0', HONEYBEE_OFFLINE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CLAUDE_CONFIG_DIR;
delete env.CODEX_HOME;

const started = Date.now();
const child = spawn(exe, [`--self-test=${resultFile}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });

const timer = setTimeout(() => {
  console.error('the packaged app did not finish its self-test within 120 s');
  child.kill('SIGKILL');
}, 120000);

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  let result = null;
  try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (_) { /* reported below */ }
  console.log(`exit ${code}${signal ? ` (signal ${signal})` : ''} after ${seconds} s`);
  if (!result) {
    console.error('no self-test result was written. App output:\n' + output.slice(-4000));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
});
