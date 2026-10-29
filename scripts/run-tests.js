// Cross-platform test runner: finds compiled *.test.js files and runs them with node --test.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const filter = process.argv[2];
function find(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? find(path.join(dir, e.name)) : e.name.endsWith('.test.js') ? [path.join(dir, e.name)] : []);
}
const files = find(path.join(__dirname, '..', 'dist', 'test')).filter(f => !filter || f.includes(filter)).sort();
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
