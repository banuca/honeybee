'use strict';

// Runs every test/*.test.js in its own Node process and reports the total.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
let failed = 0;
for (const file of files) {
  console.log(`\n${file}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  if (result.status !== 0) failed += 1;
}
console.log(`\n${files.length - failed}/${files.length} unit suites passed`);
process.exit(failed ? 1 : 0);
