import * as path from 'path';
import { spawnSync } from 'child_process';

export const CLI = path.join(__dirname, '..', 'src', 'cli', 'index.js');

export function runCli(cwd: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, input, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
