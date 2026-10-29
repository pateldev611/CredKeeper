import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnvIndex, Engine } from '../../src/core';
import { FAKE } from '../fixtures';

// T11: env-aware mode must not become a new place secrets leak from.
test('index keeps no raw values in its enumerable state', () => {
  const idx = new EnvIndex();
  idx.addFile(`DB_PASSWORD=${FAKE.envPassword}`);
  const dump = JSON.stringify(idx) + JSON.stringify(Object.entries(idx));
  assert.ok(!dump.includes(FAKE.envPassword));
});

test('hashes are salted per session, so two indexes never share hashes', () => {
  const a = new EnvIndex(), b = new EnvIndex();
  a.addFile(`DB_PASSWORD=${FAKE.envPassword}`);
  b.addFile(`DB_PASSWORD=${FAKE.envPassword}`);
  const keys = (x: EnvIndex) => [...((x as unknown as { byHash: Map<string, unknown> }).byHash.keys())];
  assert.notDeepEqual(keys(a), keys(b));
});

test('short values are never tracked, so they cannot be brute-forced from a hash', () => {
  const idx = new EnvIndex();
  assert.equal(idx.addFile('PIN_SECRET=1234567\nPWD=abc'), 0);
});

test('R19 findings expose the variable name, never the value', () => {
  const idx = new EnvIndex();
  idx.addFile(`DB_PASSWORD=${FAKE.envPassword}`);
  const f = new Engine({ envIndex: idx }).scanContent('a.txt', `pw is ${FAKE.envPassword}`).findings;
  assert.equal(f.length, 1);
  assert.ok(!JSON.stringify(f).includes(FAKE.envPassword));
  assert.equal(f[0].masked, 'value of DB_PASSWORD');
});
