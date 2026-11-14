// Runs every test suite in its own process (each gets a fresh in-memory database): npm test
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const suites = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
let failed = 0;
for (const s of suites) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], { encoding: 'utf8', env: process.env });
  const out = `${r.stdout}${r.stderr}`;
  const summary = (out.match(/\d+ passed, \d+ failed/) || ['no summary (crashed)'])[0];
  const ok = r.status === 0 && /, 0 failed/.test(summary);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${s.padEnd(18)} ${summary}  ${((Date.now() - t) / 1000).toFixed(0)} s`);
  if (!ok) console.log(out.split('\n').filter((l) => /^FAIL|Error|\.test\.js:\d+/.test(l)).slice(0, 15).map((l) => `    ${l}`).join('\n'));
}
console.log(failed ? `\n${failed} suite(s) failed` : '\nAll suites passed');
process.exit(failed ? 1 : 0);
