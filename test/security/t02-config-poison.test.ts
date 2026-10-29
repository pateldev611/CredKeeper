import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, scanWorkspace } from '../../src/core';
import { tmpDir, write, gitInit, FAKE } from '../fixtures';

// T02: a repository config must not be able to switch off protection.
test('critical rules cannot be disabled by repository config', () => {
  const { config, warnings } = parseConfig(JSON.stringify({ disabledRules: ['R01', 'R02', 'R04', 'R05', 'R07', 'R19'] }));
  assert.equal(config.disabledRules.size, 0);
  assert.ok(warnings.filter(w => /cannot be disabled/.test(w)).length >= 6);
});

test('disabling many rules produces a warning', () => {
  const { warnings } = parseConfig(JSON.stringify({ disabledRules: ['R12', 'R15', 'R16', 'R17'] }));
  assert.ok(warnings.some(w => /disables 4 rules/.test(w)));
});

test('untrusted workspace ignores .credkeeper.json entirely', () => {
  const root = tmpDir();
  gitInit(root);
  write(root, '.credkeeper.json', JSON.stringify({ disabledRules: ['R11'], excludePaths: ['**'] }));
  write(root, 'a.py', `t = "${FAKE.github}"`);
  const trusted = scanWorkspace(root, { trusted: true });
  const untrusted = scanWorkspace(root, { trusted: false });
  assert.equal(trusted.findings.filter(f => f.ruleId === 'R11').length, 0, 'trusted honours config');
  assert.ok(untrusted.findings.some(f => f.ruleId === 'R11'), 'untrusted ignores config');
});
