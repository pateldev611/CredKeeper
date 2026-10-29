#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { scanWorkspace, Finding, SEVERITY_ORDER, Severity, clearOutputs, allowlistHash, Engine, loadConfig, findEnvFiles, buildEnvIndex } from '../core';
import { gitRoot, hooksDir, isGitRepo } from '../core/git';

const HOOK_MARKER = '# credkeeper-pre-commit-hook';
const USAGE = `CredKeeper: local secret leak detection

Usage:
  credkeeper scan [paths...] [--staged] [--json] [--min-severity low|medium|high|critical]
  credkeeper fix --clear-outputs <notebook.ipynb>
  credkeeper install-hook [--force]
  credkeeper hash            (reads a value from stdin, prints its allowlist hash)

Exit codes: 0 = clean, 1 = findings, 2 = usage or runtime error.`;

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'scan': return cmdScan(rest);
    case 'fix': return cmdFix(rest);
    case 'install-hook': return cmdInstallHook(rest);
    case 'hash': return cmdHash();
    case '--help': case '-h': case 'help': case undefined:
      console.log(USAGE);
      return cmd === undefined ? 2 : 0;
    default:
      console.error(`Unknown command: ${printable(cmd)}\n\n${USAGE}`);
      return 2;
  }
}

function cmdScan(args: string[]): number {
  let json = false, staged = false;
  let minSeverity: Severity = 'medium';
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--staged') staged = true;
    else if (a === '--min-severity') {
      const v = args[++i];
      if (v !== 'low' && v !== 'medium' && v !== 'high' && v !== 'critical') { console.error('--min-severity must be low, medium, high or critical'); return 2; }
      minSeverity = v;
    } else if (a.startsWith('--')) { console.error(`Unknown option: ${printable(a)}`); return 2; }
    else paths.push(a);
  }
  const root = process.cwd();
  const result = scanWorkspace(root, { paths, staged, trusted: true });
  const findings = result.findings.filter(f => SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER[minSeverity]);

  if (json) {
    // Findings are already masked; envVar names are safe to print.
    console.log(JSON.stringify({ findings, warnings: result.warnings, filesScanned: result.filesScanned }, null, 2));
  } else {
    for (const w of result.warnings) console.error(`warning: ${w.file ? printable(w.file) + ': ' : ''}${w.message}`);
    if (findings.length === 0) {
      console.log(`CredKeeper: no secrets found (${result.filesScanned} files scanned).`);
    } else {
      for (const f of findings) console.log(formatFinding(f));
      console.log(`\nCredKeeper: ${findings.length} finding(s) in ${new Set(findings.map(f => f.file)).size} file(s).`);
      const notebooks = [...new Set(findings.filter(f => f.location.kind === 'output').map(f => f.file))];
      for (const nb of notebooks) console.log(`  Clear leaked notebook outputs: credkeeper fix --clear-outputs "${printable(nb)}"`);
      if (staged) console.log('Commit blocked. Fix the findings above, then commit again.');
    }
  }
  return findings.length > 0 ? 1 : 0;
}

function formatFinding(f: Finding): string {
  const where = f.location.kind === 'output'
    ? `cell ${f.location.cell! + 1} output (${f.location.outputType}), line ${f.line}`
    : f.location.cell !== undefined ? `cell ${f.location.cell + 1}, line ${f.line}` : `line ${f.line}`;
  const value = f.masked ? `  [${f.masked}]` : '';
  return `${printable(f.file)} ${where}\n  ${f.severity.toUpperCase()} ${f.ruleId} ${f.title}${value}\n  ${f.message}\n  Fix: ${f.fix}\n`;
}

function cmdFix(args: string[]): number {
  if (args[0] !== '--clear-outputs' || !args[1]) { console.error('Usage: credkeeper fix --clear-outputs <notebook.ipynb>'); return 2; }
  const file = path.resolve(args[1]);
  const root = process.cwd();
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { console.error('Refusing to modify a file outside the current directory.'); return 2; }
  if (!file.endsWith('.ipynb')) { console.error('Only .ipynb notebooks can have outputs cleared.'); return 2; }
  let raw: string;
  try {
    if (!fs.lstatSync(file).isFile()) { console.error('Not a regular file.'); return 2; }
    raw = fs.readFileSync(file, 'utf8');
  } catch { console.error('Cannot read the notebook.'); return 2; }

  const repoRoot = (isGitRepo(root) && gitRoot(root)) || root;
  const { config } = loadConfig(repoRoot);
  const engine = new Engine({ config, envIndex: buildEnvIndex(repoRoot, findEnvFiles(repoRoot)) });
  const cells = new Set(engine.scanContent(rel, raw).findings.filter(f => f.location.kind === 'output').map(f => f.location.cell!));
  if (cells.size === 0) { console.log('No leaked outputs found in this notebook.'); return 0; }
  const updated = clearOutputs(raw, cells);
  if (updated === null) { console.error('Notebook could not be parsed; nothing changed.'); return 2; }
  fs.writeFileSync(file, updated, 'utf8');
  console.log(`Cleared outputs of ${cells.size} cell(s): ${[...cells].map(c => c + 1).join(', ')}. Re-run those cells after fixing the code.`);
  return 0;
}

function cmdInstallHook(args: string[]): number {
  const force = args.includes('--force');
  const root = process.cwd();
  if (!isGitRepo(root)) { console.error('Not inside a Git repository.'); return 2; }
  const repoRoot = gitRoot(root)!;
  const rel = hooksDir(repoRoot);
  if (!rel) { console.error('Could not locate the Git hooks directory.'); return 2; }
  const dir = path.resolve(repoRoot, rel);
  fs.mkdirSync(dir, { recursive: true });
  const hook = path.join(dir, 'pre-commit');
  if (fs.existsSync(hook)) {
    const existing = fs.readFileSync(hook, 'utf8');
    if (!existing.includes(HOOK_MARKER) && !force) {
      console.error('A different pre-commit hook already exists. Re-run with --force to replace it (a backup is kept).');
      return 2;
    }
    if (!existing.includes(HOOK_MARKER)) fs.copyFileSync(hook, hook + '.credkeeper-backup');
  }
  const cli = path.resolve(__filename);
  // --min-severity low: the commit gate is the last line of defense, so it must also catch
  // generic high-entropy strings (R17) that no named or provider-specific rule recognises.
  const script = `#!/bin/sh\n${HOOK_MARKER}\n# Blocks commits that contain secrets. Bypass (discouraged): git commit --no-verify\nexec node ${shQuote(cli)} scan --staged --min-severity low\n`;
  fs.writeFileSync(hook, script, { mode: 0o755 });
  console.log(`Installed pre-commit hook at ${hook}`);
  return 0;
}

function cmdHash(): number {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  const value = input.replace(/\r?\n$/, '');
  if (!value) { console.error('Pipe the value on stdin, e.g.: echo -n "value" | credkeeper hash'); return 2; }
  console.log(allowlistHash(value));
  return 0;
}

/** POSIX single-quote escaping for the hook script. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Strip control characters so hostile file names can't inject terminal escape sequences. */
function printable(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, '?');
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch {
  console.error('CredKeeper hit an unexpected error. No secrets were printed.');
  process.exitCode = 2;
}
