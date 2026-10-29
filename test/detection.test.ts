import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { Engine } from '../src/core';
import { buildCorpus, FAKE } from './fixtures';

const root = buildCorpus();
const engine = new Engine();
const scan = (rel: string) => engine.scanContent(rel, fs.readFileSync(path.join(root, rel), 'utf8')).findings;
const ids = (rel: string) => scan(rel).map(f => f.ruleId);

test('python file: every planted secret is detected with the right rule', () => {
  const got = ids('positive/app.py');
  for (const id of ['R02', 'R03', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'R01']) assert.ok(got.includes(id), `missing ${id}; got ${got}`);
});

test('spark and databricks credentials', () => {
  const got = ids('positive/spark_setup.py');
  assert.ok(got.includes('R07'), `got ${got}`);
  assert.ok(got.includes('R04'), `got ${got}`);
});

test('JDBC, YAML, Azure connection string, SAS and Snowflake', () => {
  assert.ok(ids('positive/connect.sql').includes('R09'));
  assert.ok(ids('positive/settings.yaml').includes('R16'));
  assert.ok(ids('positive/storage.json').includes('R05'));
  assert.ok(ids('positive/sas.py').includes('R06'));
  assert.ok(ids('positive/snow.py').includes('R08'));
});

test('notebook: secrets in stream output, error traceback and execute_result are found with cell numbers', () => {
  const f = scan('positive/explore.ipynb');
  const outputs = f.filter(x => x.location.kind === 'output');
  assert.ok(outputs.some(x => x.location.cell === 1 && x.location.outputType === 'stream' && x.ruleId === 'R16'), JSON.stringify(outputs.map(o => [o.ruleId, o.location])));
  assert.ok(outputs.some(x => x.location.cell === 2 && x.location.outputType === 'error' && x.ruleId === 'R10'));
  assert.ok(outputs.some(x => x.location.cell === 3 && x.ruleId === 'R04'));
  assert.equal(f.filter(x => x.location.kind === 'code').length, 0, 'code cells are clean');
});

test('negative corpus: no findings at medium or above', () => {
  for (const rel of ['negative/safe.py', 'negative/config.yaml', 'negative/clean.ipynb']) {
    const f = scan(rel).filter(x => x.severity !== 'low');
    assert.equal(f.length, 0, `${rel}: ${JSON.stringify(f.map(x => [x.ruleId, x.line]))}`);
  }
});

test('values are always masked to at most 4 visible characters', () => {
  for (const f of scan('positive/app.py')) {
    assert.ok(!f.masked.includes(FAKE.github) && !f.masked.includes(FAKE.dbPassword));
    assert.match(f.masked, /^.{0,4}\*+$/);
  }
});

test('inline ignore comment suppresses the line; rule-specific ignore only that rule', () => {
  const e = new Engine();
  assert.equal(e.scanContent('a.py', `k = "${FAKE.github}"  # credkeeper:ignore`).findings.length, 0);
  assert.equal(e.scanContent('a.py', `k = "${FAKE.github}"  # credkeeper:ignore R02`).findings.length, 1);
});

test('.env files themselves are not flagged; overlapping matches report once', () => {
  assert.equal(new Engine().scanContent('.env', `DB_PASSWORD=${FAKE.dbPassword}`).findings.length, 0);
  const f = new Engine().scanContent('a.py', `url = "postgresql://u:${FAKE.dbPassword}@h/db"`).findings;
  assert.equal(f.length, 1);
});

test('precision and recall on the corpus', () => {
  const positives = ['positive/app.py', 'positive/spark_setup.py', 'positive/connect.sql', 'positive/settings.yaml', 'positive/storage.json', 'positive/sas.py', 'positive/snow.py', 'positive/explore.ipynb'];
  const found = positives.reduce((n, p) => n + scan(p).filter(f => f.severity !== 'low').length, 0);
  assert.ok(found >= 20, `expected at least 20 findings, got ${found}`);
});
