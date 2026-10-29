import { execFileSync } from 'child_process';

/**
 * All git calls go through execFileSync with an argument array: no shell, so file names
 * such as "a; rm -rf ~.py" or "$(curl x).py" are passed as plain data.
 */
export function git(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024): { ok: boolean; out: Buffer; code: number } {
  try {
    const out = execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer, windowsHide: true });
    return { ok: true, out, code: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer };
    return { ok: false, out: err.stdout ?? Buffer.alloc(0), code: err.status ?? -1 };
  }
}

export function isGitRepo(cwd: string): boolean {
  const r = git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.out.toString().trim() === 'true';
}

export function gitRoot(cwd: string): string | null {
  const r = git(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok ? r.out.toString().trim() : null;
}

/** NUL-separated output so names with newlines or spaces are handled safely. */
function splitZ(buf: Buffer): string[] {
  return buf.toString('utf8').split('\0').filter(Boolean);
}

/** Tracked + untracked-but-not-ignored files, respecting .gitignore. */
export function listRepoFiles(root: string): string[] {
  const r = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return r.ok ? splitZ(r.out) : [];
}

export function stagedFiles(root: string): string[] {
  const r = git(root, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']);
  return r.ok ? splitZ(r.out) : [];
}

/** Content of a file as staged in the index (what will actually be committed). */
export function stagedContent(root: string, relPath: string, maxBytes: number): Buffer | null {
  const r = git(root, ['show', `:${relPath}`], maxBytes + 1);
  if (!r.ok || r.out.length > maxBytes) return null;
  return r.out;
}

/** True if Git would ignore this path (checks rules even for tracked files). */
export function isIgnored(root: string, relPath: string): boolean {
  return git(root, ['check-ignore', '-q', '--no-index', '--', relPath]).code === 0;
}

export function isTracked(root: string, relPath: string): boolean {
  return git(root, ['ls-files', '--error-unmatch', '--', relPath]).ok;
}

export function hooksDir(root: string): string | null {
  const r = git(root, ['rev-parse', '--git-path', 'hooks']);
  return r.ok ? r.out.toString().trim() : null;
}
