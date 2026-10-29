import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, EnvIndex } from '../../src/core';

// T01: adversarial input must not stall any rule.
const ADVERSARIAL = [
  'a'.repeat(100_000),
  'password'.repeat(10_000) + '=',
  'jdbc:' + 'x'.repeat(50_000),
  'Driver=' + ';'.repeat(50_000),
  'postgresql://' + 'u'.repeat(50_000) + ':',
  '"' + 'A1+/'.repeat(25_000) + '"',
  'eyJ' + 'a'.repeat(30_000) + '.eyJ' + 'b'.repeat(30_000),
  ('x = "' + 'k'.repeat(7) + '" ').repeat(5_000),
  'spark.conf.set("fs.azure.account.key' + 'z'.repeat(50_000),
  '\u001b['.repeat(20_000),
];

for (const [i, input] of ADVERSARIAL.entries()) {
  test(`adversarial input #${i + 1} scans in under 500 ms`, () => {
    const env = new EnvIndex();
    env.addFile('SECRET_TOKEN=Abc123!xyzQ\n');
    const t0 = Date.now();
    new Engine({ envIndex: env }).scanContent('evil.py', input);
    const ms = Date.now() - t0;
    assert.ok(ms < 500, `took ${ms} ms`);
  });
}

test('a secret hidden after 50,000 characters of padding is still found', () => {
  const f = new Engine().scanContent('pad.py', ' '.repeat(50_000) + 'x = "' + 'gh' + 'p_' + 'A1b2C3d4'.repeat(4) + 'E5f6"');
  assert.ok(f.findings.some(x => x.ruleId === 'R11'));
});
