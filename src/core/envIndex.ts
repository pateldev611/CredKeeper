import { createHash, randomBytes } from 'crypto';
import { isPlaceholder } from './placeholders';
import { nameLooksSecret } from './rules';
import { shannonEntropy } from './entropy';

export interface EnvEntry {
  name: string;
  value: string;
  line: number;
}

export interface EnvMatch {
  varName: string;
  start: number;
  end: number;
}

const MIN_VALUE_LENGTH = 8;
const MAX_VALUE_LENGTH = 500;

/** Parse KEY=VALUE lines. Supports `export`, quotes and trailing comments on unquoted values. */
export function parseEnv(raw: string): EnvEntry[] {
  const out: EnvEntry[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length && i < 10_000; i++) {
    const m = /^\s{0,20}(?:export\s{1,5})?([A-Za-z_][A-Za-z0-9_.\-]{0,100})\s{0,5}=\s{0,5}(.{0,2000})$/.exec(lines[i]);
    if (!m) continue;
    let value = m[2].trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2) {
      const end = value.indexOf(q, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out.push({ name: m[1], value, line: i + 1 });
  }
  return out;
}

/** Decide whether a .env value is a secret worth tracking (avoids flagging hosts, regions, flags). */
export function isTrackableSecret(name: string, value: string): boolean {
  if (value.length < MIN_VALUE_LENGTH || value.length > MAX_VALUE_LENGTH) return false;
  if (isPlaceholder(value)) return false;
  if (nameLooksSecret(name)) return true;
  // Not obviously a secret by name: require it to look random, and not like a URL, host or path.
  if (/:\/\//.test(value) && !/@/.test(value)) return false;
  if (/^[a-z0-9.\-]+$/i.test(value) && /\./.test(value)) return false; // hostname
  if (/^[\/~.]/.test(value) || /^[A-Za-z]:\\/.test(value)) return false; // path
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(value)).length;
  return classes >= 3 && shannonEntropy(value) >= 3.0;
}

/**
 * Holds salted SHA-256 hashes of .env secret values, in memory only.
 * Raw values are discarded after hashing; findings carry only the variable name.
 */
export class EnvIndex {
  private readonly salt = randomBytes(16);
  private readonly byHash = new Map<string, Set<string>>();
  private readonly lengths = new Set<number>();

  get size(): number {
    return this.byHash.size;
  }

  addFile(raw: string): number {
    let added = 0;
    for (const e of parseEnv(raw)) {
      if (!isTrackableSecret(e.name, e.value)) continue;
      const h = this.hash(e.value);
      if (!this.byHash.has(h)) this.byHash.set(h, new Set());
      this.byHash.get(h)!.add(e.name);
      this.lengths.add(e.value.length);
      added++;
    }
    return added;
  }

  private hash(v: string): string {
    return createHash('sha256').update(this.salt).update(v, 'utf8').digest('hex');
  }

  /** Find exact occurrences of tracked values in a line of text, using delimiter-based candidates. */
  match(text: string): EnvMatch[] {
    if (this.byHash.size === 0) return [];
    const found = new Map<string, EnvMatch>();
    const tryCandidate = (start: number, cand: string) => {
      if (!this.lengths.has(cand.length)) return;
      const names = this.byHash.get(this.hash(cand));
      if (!names) return;
      const varName = [...names].sort()[0];
      found.set(`${start}:${cand.length}`, { varName, start, end: start + cand.length });
    };
    const outer = /[^\s"'`,()\[\]{}<>|\\]+/g;
    let m: RegExpExecArray | null;
    while ((m = outer.exec(text)) !== null) {
      const tok = m[0];
      const base = m.index;
      tryCandidate(base, tok);
      const trimmed = tok.replace(/[.,;:]+$/, '');
      if (trimmed !== tok) tryCandidate(base, trimmed);
      for (const sep of ['=', ':']) {
        const i = tok.indexOf(sep);
        if (i >= 0 && i < tok.length - 1) {
          tryCandidate(base + i + 1, tok.slice(i + 1));
          tryCandidate(base + i + 1, tok.slice(i + 1).replace(/[.,;:]+$/, ''));
        }
      }
      const inner = /[^=:@;&?\/]+/g;
      let p: RegExpExecArray | null;
      while ((p = inner.exec(tok)) !== null) tryCandidate(base + p.index, p[0]);
    }
    return [...found.values()];
  }
}

/** Unsalted SHA-256, for shareable allowlist entries in .credkeeper.json. */
export function allowlistHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
