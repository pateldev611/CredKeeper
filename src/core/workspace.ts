import * as fs from 'fs';
import * as path from 'path';
import { Engine } from './engine';
import { EnvIndex } from './envIndex';
import { ConfigLoadResult, defaultConfig, parseConfig, CredKeeperConfig } from './config';
import { classify, isBinary, isEnvFile, SKIP_DIRS } from './files';
import { Finding, ScanResult, ScanWarning } from './types';
import { FILE_RULES } from './rules';
import * as g from './git';

export interface WorkspaceOptions {
  /** Untrusted workspaces: repository config is NOT loaded and env-aware mode is off. */
  trusted?: boolean;
  /** Scan only these paths (relative to root). Default: whole workspace. */
  paths?: string[];
  /** Scan what is staged in the Git index instead of the working tree. */
  staged?: boolean;
}

const MAX_WALK_FILES = 50_000;

export function loadConfig(root: string): ConfigLoadResult {
  const p = path.join(root, '.credkeeper.json');
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile()) return { config: defaultConfig(), warnings: ['.credkeeper.json is not a regular file and was ignored.'] };
    return parseConfig(fs.readFileSync(p, 'utf8'));
  } catch {
    return { config: defaultConfig(), warnings: [] };
  }
}

/** Find real .env files anywhere in the workspace, including ones Git ignores. */
export function findEnvFiles(root: string): string[] {
  const out: string[] = [];
  walk(root, root, f => { if (isEnvFile(f)) out.push(f); }, 0);
  return out;
}

export function buildEnvIndex(root: string, envFiles: string[]): EnvIndex {
  const idx = new EnvIndex();
  for (const rel of envFiles) {
    try {
      const abs = path.join(root, rel);
      if (!fs.lstatSync(abs).isFile()) continue; // no symlinks out of the workspace
      if (fs.statSync(abs).size > 256 * 1024) continue;
      idx.addFile(fs.readFileSync(abs, 'utf8'));
    } catch { /* unreadable env file: skip */ }
  }
  return idx;
}

function walk(root: string, dir: string, onFile: (rel: string) => void, depth: number, counter = { n: 0 }): void {
  if (depth > 25 || counter.n > MAX_WALK_FILES) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (counter.n++ > MAX_WALK_FILES) return;
    const abs = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue; // never follow links out of the workspace
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, abs, onFile, depth + 1, counter);
    } else if (e.isFile()) {
      onFile(path.relative(root, abs).split(path.sep).join('/'));
    }
  }
}

/** True if `rel` matches one of the repository's configured excludePaths globs. Shared by
 *  the batch workspace scan and the editor's live per-document scan, so both agree. */
export function excluded(config: CredKeeperConfig, rel: string): boolean {
  return config.excludePaths.some(re => re.test(rel));
}

export function scanWorkspace(rootIn: string, opts: WorkspaceOptions = {}): ScanResult {
  const trusted = opts.trusted ?? true;
  const warnings: ScanWarning[] = [];
  const isRepo = g.isGitRepo(rootIn);
  const root = (isRepo && g.gitRoot(rootIn)) || path.resolve(rootIn);

  const cfg = trusted ? loadConfig(root) : { config: defaultConfig(), warnings: ['Untrusted workspace: .credkeeper.json and env-aware mode are disabled.'] };
  cfg.warnings.forEach(message => warnings.push({ file: '.credkeeper.json', message }));
  const config = cfg.config;

  const envFiles = findEnvFiles(root);
  const envIndex = trusted ? buildEnvIndex(root, envFiles) : new EnvIndex();
  const engine = new Engine({ config, envIndex });
  const findings: Finding[] = [];

  // R18: real .env files that Git would not ignore.
  if (isRepo && !config.disabledRules.has('R18')) {
    for (const rel of envFiles) {
      if (!g.isIgnored(root, rel) || g.isTracked(root, rel)) {
        const tracked = g.isTracked(root, rel);
        const r = FILE_RULES.R18;
        findings.push({
          ruleId: r.id, title: r.title, severity: tracked ? 'critical' : r.severity, file: rel, line: 1, column: 0, endColumn: 0,
          masked: '', message: tracked ? 'This .env file is already tracked by Git, so its secrets are in the repository.' : r.message,
          fix: tracked ? 'Run "git rm --cached <file>", add it to .gitignore, and rotate its secrets.' : r.fix,
          location: { kind: 'file' },
        });
      }
    }
  } else if (!isRepo) {
    warnings.push({ message: 'Not a Git repository: .gitignore check (R18) and staged scanning are unavailable.' });
  }

  let files: string[];
  if (opts.staged) {
    if (!isRepo) return { findings, warnings, filesScanned: 0 };
    files = g.stagedFiles(root);
  } else if (opts.paths && opts.paths.length > 0) {
    files = expandPaths(root, opts.paths, isRepo);
  } else {
    files = isRepo ? g.listRepoFiles(root) : [];
    if (!isRepo) walk(root, root, f => files.push(f), 0);
  }

  let scanned = 0;
  for (const rel of files) {
    if (classify(rel) === 'unsupported' || excluded(config, rel)) continue;
    let buf: Buffer | null = null;
    if (opts.staged) {
      buf = g.stagedContent(root, rel, config.maxFileSizeBytes);
      if (!buf) { warnings.push({ file: rel, message: 'Staged file too large or unreadable; skipped.' }); continue; }
    } else {
      try {
        const abs = path.join(root, rel);
        const st = fs.lstatSync(abs);
        if (!st.isFile()) continue;
        if (st.size > config.maxFileSizeBytes) { warnings.push({ file: rel, message: 'File larger than size limit; skipped.' }); continue; }
        buf = fs.readFileSync(abs);
      } catch { continue; }
    }
    if (isBinary(buf)) continue;
    const r = engine.scanContent(rel, buf.toString('utf8'));
    findings.push(...r.findings);
    warnings.push(...r.warnings);
    scanned++;
  }
  return { findings, warnings, filesScanned: scanned };
}

function expandPaths(root: string, paths: string[], isRepo: boolean): string[] {
  const all = isRepo ? g.listRepoFiles(root) : (() => { const a: string[] = []; walk(root, root, f => a.push(f), 0); return a; })();
  const wanted = paths.map(p => path.relative(root, path.resolve(p)).split(path.sep).join('/'));
  return all.filter(f => wanted.some(w => w === '' || f === w || f.startsWith(w + '/')));
}
