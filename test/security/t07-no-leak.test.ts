import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCorpus, allFakeValues, gitInit, write, FAKE } from '../fixtures';
import { runCli } from '../helpers';

// T07: the tool itself must never print a secret, in any output mode.
const root = buildCorpus();
gitInit(root);
write(root, '.env', `DB_PASSWORD=${FAKE.envPassword}\nINTERNAL=${FAKE.customToken}\n`);
write(root, 'leak.yaml', `a: ${FAKE.envPassword}\nb: ${FAKE.customToken}\n`);

const leaksIn = (out: string) => allFakeValues().filter(v => v.length >= 8 && out.includes(v));

test('text output contains no raw secret', () => {
  const r = runCli(root, ['scan', '--min-severity', 'low']);
  assert.equal(r.code, 1);
  assert.deepEqual(leaksIn(r.out), []);
});

test('JSON output contains no raw secret', () => {
  const r = runCli(root, ['scan', '--json', '--min-severity', 'low']);
  assert.deepEqual(leaksIn(r.out), []);
  const parsed = JSON.parse(r.out);
  assert.ok(parsed.findings.length > 20);
});

test('staged scan output contains no raw secret', () => {
  require('child_process').execFileSync('git', ['add', '-A'], { cwd: root });
  const r = runCli(root, ['scan', '--staged']);
  assert.equal(r.code, 1);
  assert.deepEqual(leaksIn(r.out), []);
});
