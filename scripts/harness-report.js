// Runs each security spec and prints a pass/fail table for the demo.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const THREATS = {
  t01: 'Regex denial of service', t02: 'Poisoned config', t03: 'Config code execution / schema',
  t04: 'Command injection via file names', t05: 'Path traversal / symlinks', t07: 'Secret leakage by the tool',
  t09: 'Malformed notebooks', t11: '.env values exposed by env-aware mode',
};
const dir = path.join(__dirname, '..', 'dist', 'test', 'security');
let failed = 0;
console.log('\nCredKeeper security harness\n');
console.log('Threat  Description                              Tests   Result');
console.log('------  ---------------------------------------  ------  ------');
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort()) {
  const id = file.slice(0, 3);
  const r = spawnSync(process.execPath, ['--test', path.join(dir, file)], { encoding: 'utf8' });
  const pass = +(/# pass (\d+)/.exec(r.stdout)?.[1] ?? 0), fail = +(/# fail (\d+)/.exec(r.stdout)?.[1] ?? 0);
  failed += fail;
  console.log(`${id.toUpperCase().padEnd(6)}  ${(THREATS[id] ?? file).padEnd(39)}  ${`${pass}/${pass + fail}`.padEnd(6)}  ${fail ? 'FAIL' : 'PASS'}`);
}
console.log(`\n${failed ? `${failed} test(s) failed` : 'All security specs passed'}\n`);
process.exit(failed ? 1 : 0);
