import * as path from 'path';

export type FileKind = 'notebook' | 'env' | 'env-template' | 'config' | 'code' | 'unsupported';

const CODE_EXT = new Set(['.py', '.sql', '.scala', '.r', '.sh', '.ps1', '.js', '.ts', '.java', '.cs', '.go', '.md', '.txt', '.json', '.tf', '.pem', '.key', '.crt', '.cer', '.ppk', '.p12', '.pfx']);
const CONFIG_EXT = new Set(['.yaml', '.yml', '.toml', '.cfg', '.ini', '.properties', '.conf']);
const TEMPLATE_SUFFIX = /\.(?:example|sample|template|tmpl|dist|defaults?)$/i;
/** Common extensionless private key filenames. */
const KEY_BASENAMES = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']);

/** Real env files hold secrets legitimately: .env, .env.local, .env.prod, prod.env */
export function isEnvFile(file: string): boolean {
  const base = path.basename(file);
  if (TEMPLATE_SUFFIX.test(base)) return false;
  return /^\.env(?:\.[A-Za-z0-9_\-]{1,40})?$/.test(base) || /^[A-Za-z0-9_\-]{1,60}\.env$/.test(base);
}

export function isEnvTemplate(file: string): boolean {
  const base = path.basename(file);
  return TEMPLATE_SUFFIX.test(base) && /(?:^\.env|\.env\.)/.test(base);
}

export function classify(file: string): FileKind {
  const base = path.basename(file);
  if (isEnvTemplate(file)) return 'env-template';
  if (isEnvFile(file)) return 'env';
  if (KEY_BASENAMES.has(base)) return 'code';
  const ext = path.extname(base).toLowerCase();
  if (ext === '.ipynb') return 'notebook';
  if (CONFIG_EXT.has(ext)) return 'config';
  if (CODE_EXT.has(ext)) return 'code';
  if (/^(?:Dockerfile|Makefile|Jenkinsfile)$/i.test(base)) return 'code';
  return 'unsupported';
}

export const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache', 'dist', 'build', '.tox', '.ipynb_checkpoints', 'site-packages']);

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Resolve target and refuse anything outside root (handles ../ and symlinked parents). */
export function resolveInside(root: string, target: string, realpath: (p: string) => string): string | null {
  const rootReal = realpath(root);
  const abs = path.resolve(rootReal, target);
  let probe = abs;
  // Walk up to the nearest existing ancestor, resolve symlinks there.
  for (let i = 0; i < 64; i++) {
    try {
      const real = path.join(realpath(probe), path.relative(probe, abs));
      const rel = path.relative(rootReal, real);
      return rel.startsWith('..') || path.isAbsolute(rel) ? null : real;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
  return null;
}
