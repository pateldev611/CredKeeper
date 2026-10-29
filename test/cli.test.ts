import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync, execFileSync } from 'child_process';
import { tmpDir, write, gitInit, notebook, stream, FAKE } from './fixtures';
import { runCli } from './helpers';

test('scan: exit 0 when clean, 1 with findings, 2 on bad usage', () => {
  const root = tmpDir();
  gitInit(root);
  write(root, 'ok.py', 'x = 1\n');
  assert.equal(runCli(root, ['scan']).code, 0);
  write(root, 'bad.py', `t = "${FAKE.github}"\n`);
  assert.equal(runCli(root, ['scan']).code, 1);
  assert.equal(runCli(root, ['scan', '--bogus']).code, 2);
});

test('R18: .env not in .gitignore is flagged; once ignored it is not', () => {
  const root = tmpDir();
  gitInit(root);
  write(root, '.env', `DB_PASSWORD=${FAKE.envPassword}\n`);
  write(root, '.env.prod', `DB_PASSWORD=${FAKE.envPassword}\n`);
  write(root, '.gitignore', '.env\n');
  const r = JSON.parse(runCli(root, ['scan', '--json']).out);
  const r18 = r.findings.filter((f: { ruleId: string }) => f.ruleId === 'R18').map((f: { file: string }) => f.file);
  assert.deepEqual(r18, ['.env.prod']);
  write(root, '.gitignore', '.env*\n!.env.example\n');
  assert.equal(JSON.parse(runCli(root, ['scan', '--json']).out).findings.filter((f: { ruleId: string }) => f.ruleId === 'R18').length, 0);
});

test('pre-commit hook blocks a commit with a secret and allows it after the fix', { skip: process.platform === 'win32' }, () => {
  const root = tmpDir();
  gitInit(root);
  assert.equal(runCli(root, ['install-hook']).code, 0);
  write(root, '.gitignore', '.env\n');
  write(root, '.env', `DB_PASSWORD=${FAKE.envPassword}\n`);
  write(root, 'notes.yaml', `password: ${FAKE.envPassword}\n`);
  execFileSync('git', ['add', '.gitignore', 'notes.yaml'], { cwd: root });
  const blocked = spawnSync('git', ['commit', '-m', 'leak'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(blocked.status, 0, 'commit should be blocked');
  assert.match(blocked.stdout + blocked.stderr, /R19/);
  assert.ok(!(blocked.stdout + blocked.stderr).includes(FAKE.envPassword));
  write(root, 'notes.yaml', 'password: ${DB_PASSWORD}\n');
  execFileSync('git', ['add', 'notes.yaml'], { cwd: root });
  const ok = spawnSync('git', ['commit', '-m', 'clean'], { cwd: root, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});

test('staged scan checks the staged version, not the working copy', () => {
  const root = tmpDir();
  gitInit(root);
  write(root, 'a.py', `t = "${FAKE.github}"\n`);
  execFileSync('git', ['add', 'a.py'], { cwd: root });
  write(root, 'a.py', 'x = 1\n'); // fixed on disk but not re-staged
  assert.equal(runCli(root, ['scan', '--staged']).code, 1);
});

test('install-hook refuses to overwrite a foreign hook without --force, keeps a backup with it', () => {
  const root = tmpDir();
  gitInit(root);
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  write(root, '.git/hooks/pre-commit', '#!/bin/sh\necho mine\n');
  assert.equal(runCli(root, ['install-hook']).code, 2);
  assert.equal(runCli(root, ['install-hook', '--force']).code, 0);
  assert.ok(fs.existsSync(hook + '.credkeeper-backup'));
});

test('fix --clear-outputs clears only the leaking cells', () => {
  const root = tmpDir();
  const nbPath = write(root, 'explore.ipynb', notebook([
    { source: 'print("hi")', outputs: [stream('hi\n')] },
    { source: 'print(cfg)', outputs: [stream(`{'password': '${FAKE.snowPassword}'}`)] },
  ]));
  const r = runCli(root, ['fix', '--clear-outputs', 'explore.ipynb']);
  assert.equal(r.code, 0, r.out);
  const nb = JSON.parse(fs.readFileSync(nbPath, 'utf8'));
  assert.equal(nb.cells[0].outputs.length, 1, 'clean cell untouched');
  assert.equal(nb.cells[1].outputs.length, 0, 'leaking cell cleared');
  assert.equal(runCli(root, ['scan', 'explore.ipynb']).code, 0);
});

test('hash reads from stdin and matches the allowlist format', () => {
  const r = runCli(tmpDir(), ['hash'], 'some-test-value');
  assert.match(r.out.trim(), /^[0-9a-f]{64}$/);
});
