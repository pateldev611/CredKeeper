import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, globToRegExp } from '../../src/core';

// T03: config is data only. No code, no prototype pollution, no regex from users.
test('prototype pollution keys are dropped', () => {
  parseConfig('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}}');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('wrong types and unknown keys are ignored with warnings, never thrown', () => {
  for (const raw of ['', 'null', '[]', '42', '{"disabledRules": "R16"}', '{"allowlist": [1,2]}', '{"run": "rm -rf /"}', '{"maxFileSizeKB": 1e12}', '{'.repeat(10_000)]) {
    const r = parseConfig(raw);
    assert.ok(r.config);
  }
  const r = parseConfig('{"run": "rm -rf /"}');
  assert.ok(r.warnings.some(w => /Unknown key/.test(w)));
});

test('allowlist accepts only SHA-256 hashes, never raw values', () => {
  const r = parseConfig(JSON.stringify({ allowlist: ['my-real-password', 'a'.repeat(64)] }));
  assert.equal(r.config.allowlist.size, 1);
});

test('glob patterns are bounded so they cannot become slow regexes', () => {
  assert.equal(globToRegExp('*a*a*a*a*a*a*a*a*'), null);
  assert.equal(globToRegExp('x'.repeat(300)), null);
  const re = globToRegExp('tests/**')!;
  assert.ok(re.test('tests/a/b.py') && !re.test('src/tests.py'));
  const t0 = Date.now();
  globToRegExp('*a*a*a*a*a*')!.test('a'.repeat(5_000) + '/');
  assert.ok(Date.now() - t0 < 200);
});

test('oversized config is ignored', () => {
  const r = parseConfig(JSON.stringify({ excludePaths: ['x'.repeat(70_000)] }));
  assert.ok(r.warnings.some(w => /64 KB/.test(w)));
});
