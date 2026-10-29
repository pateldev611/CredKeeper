import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { resolveInside } from '../../src/core';
import { tmpDir, write } from '../fixtures';
import { runCli } from '../helpers';

// T05: writes must stay inside the workspace.
test('resolveInside rejects ../ escapes and symlinked directories', () => {
  const root = tmpDir();
  const outside = tmpDir();
  const rp = (p: string) => fs.realpathSync(p);
  assert.ok(resolveInside(root, '.env', rp));
  assert.ok(resolveInside(root, 'sub/new/.env', rp));
  assert.equal(resolveInside(root, '../.env', rp), null);
  assert.equal(resolveInside(root, path.join(outside, '.env'), rp), null);
  if (process.platform !== 'win32') {
    fs.symlinkSync(outside, path.join(root, 'link'));
    assert.equal(resolveInside(root, 'link/.env', rp), null);
  }
});

test('fix --clear-outputs refuses files outside the current directory', () => {
  const root = tmpDir();
  const outside = tmpDir();
  const nb = write(outside, 'x.ipynb', '{"cells": []}');
  const r = runCli(root, ['fix', '--clear-outputs', nb]);
  assert.equal(r.code, 2);
  assert.match(r.out, /outside/);
});

test('symlinked files are not followed by the workspace scan', { skip: process.platform === 'win32' }, () => {
  const root = tmpDir();
  const outside = tmpDir();
  write(outside, 'secret.py', 'x = "' + 'gh' + 'p_' + 'A1b2C3d4'.repeat(4) + 'E5f6"');
  fs.symlinkSync(path.join(outside, 'secret.py'), path.join(root, 'link.py'));
  const r = runCli(root, ['scan', '--json']);
  assert.equal(JSON.parse(r.out.slice(r.out.indexOf('{'))).findings.length, 0);
});
