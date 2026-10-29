import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { tmpDir, write, gitInit, FAKE } from '../fixtures';
import { runCli } from '../helpers';

// T04: hostile file names must be treated as data, never executed.
test('hostile file names in a staged scan do not execute commands', { skip: process.platform === 'win32' }, () => {
  const root = tmpDir();
  gitInit(root);
  const names = ['a; touch PWNED1 ;.py', '$(touch PWNED2).py', '`touch PWNED3`.py', '-rf.py', 'x\nnewline.py'];
  for (const n of names) write(root, n, `t = "${FAKE.github}"`);
  execFileSync('git', ['add', '--', ...names], { cwd: root });
  const r = runCli(root, ['scan', '--staged']);
  assert.equal(r.code, 1);
  for (const p of ['PWNED1', 'PWNED2', 'PWNED3']) assert.equal(fs.existsSync(path.join(root, p)), false, `${p} was created`);
});

test('control characters in file names are not echoed to the terminal', { skip: process.platform === 'win32' }, () => {
  const root = tmpDir();
  gitInit(root);
  write(root, 'evil\u001b[2Jname.py', `t = "${FAKE.github}"`);
  const r = runCli(root, ['scan']);
  assert.ok(!r.out.includes('\u001b[2J'));
});
