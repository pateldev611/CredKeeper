import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, EnvIndex, isTrackableSecret, parseEnv } from '../src/core';
import { FAKE, notebook, stream, errorOut } from './fixtures';

function engineWithEnv(env: string) {
  const idx = new EnvIndex();
  idx.addFile(env);
  return new Engine({ envIndex: idx });
}

test('parseEnv handles export, quotes and comments', () => {
  const e = parseEnv(`# c\nexport A="x y"\nB='q'\nC=plain # note\nD=`);
  assert.deepEqual(e.map(x => [x.name, x.value]), [['A', 'x y'], ['B', 'q'], ['C', 'plain'], ['D', '']]);
});

test('only secret-like values are tracked (no hosts, regions or flags)', () => {
  assert.equal(isTrackableSecret('DB_PASSWORD', FAKE.envPassword), true);
  assert.equal(isTrackableSecret('INTERNAL_THING', FAKE.customToken), true, 'random-looking custom value');
  assert.equal(isTrackableSecret('DB_HOST', 'db.example.com'), false);
  assert.equal(isTrackableSecret('REGION', 'us-east-1'), false);
  assert.equal(isTrackableSecret('DEBUG', 'true'), false);
  assert.equal(isTrackableSecret('API_URL', 'https://api.example.com/v1'), false);
});

test('R19: .env value found in YAML, notebook output and traceback, by variable name only', () => {
  const e = engineWithEnv(`DB_PASSWORD=${FAKE.envPassword}\nINTERNAL=${FAKE.customToken}\nDB_HOST=db.example.com`);
  const yaml = e.scanContent('notes.yaml', `password: ${FAKE.envPassword}`).findings;
  assert.ok(yaml.some(f => f.ruleId === 'R19' && f.envVar === 'DB_PASSWORD'));
  const nb = e.scanContent('x.ipynb', notebook([
    { source: 'print(cfg)', outputs: [stream(`{'pw': '${FAKE.envPassword}'}`)] },
    { source: 'connect()', outputs: [errorOut('fail', [`postgres://u:${FAKE.customToken}@h`])] },
  ])).findings.filter(f => f.ruleId === 'R19');
  assert.equal(nb.length, 2, JSON.stringify(nb.map(f => f.location)));
  for (const f of [...yaml, ...nb]) {
    assert.ok(!JSON.stringify(f).includes(FAKE.envPassword) && !JSON.stringify(f).includes(FAKE.customToken), 'value never in finding');
  }
});

test('custom token with no known format is caught only by env-aware mode', () => {
  const plain = new Engine().scanContent('readme.md', `use ${FAKE.customToken} to log in`).findings;
  assert.equal(plain.filter(f => f.severity !== 'low').length, 0);
  const aware = engineWithEnv(`INTERNAL=${FAKE.customToken}`).scanContent('readme.md', `use ${FAKE.customToken} to log in`).findings;
  assert.ok(aware.some(f => f.ruleId === 'R19' && f.envVar === 'INTERNAL'));
});

test('R20: real value copied into .env.example', () => {
  const e = engineWithEnv(`DB_PASSWORD=${FAKE.envPassword}`);
  const f = e.scanContent('.env.example', `DB_PASSWORD=${FAKE.envPassword}\nDB_HOST=`).findings;
  assert.ok(f.some(x => x.ruleId === 'R20' && x.envVar === 'DB_PASSWORD'));
  assert.equal(e.scanContent('.env.example', 'DB_PASSWORD=\n').findings.length, 0);
});

test('host values in .env do not create false positives', () => {
  const e = engineWithEnv('DB_HOST=db.example.com\nREGION=us-east-1');
  assert.equal(e.scanContent('a.py', 'host = "db.example.com"').findings.filter(f => f.ruleId === 'R19').length, 0);
});
