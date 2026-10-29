import { ALL_RULE_IDS, UNDISABLEABLE } from './rules';

export interface CredKeeperConfig {
  disabledRules: Set<string>;
  /** SHA-256 hex hashes of values to ignore (unsalted, so teams can share them). */
  allowlist: Set<string>;
  excludePaths: RegExp[];
  maxFileSizeBytes: number;
}

export interface ConfigLoadResult {
  config: CredKeeperConfig;
  warnings: string[];
}

export const DEFAULT_MAX_FILE_SIZE = 2 * 1024 * 1024;
const MAX_CONFIG_BYTES = 64 * 1024;
const ALLOWED_KEYS = new Set(['disabledRules', 'allowlist', 'excludePaths', 'maxFileSizeKB']);

export function defaultConfig(): CredKeeperConfig {
  return { disabledRules: new Set(), allowlist: new Set(), excludePaths: [], maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE };
}

/**
 * Parse .credkeeper.json with a strict schema. Invalid input never throws and is never executed:
 * bad fields are dropped with a warning. Untrusted workspaces must not call this at all.
 */
export function parseConfig(raw: string): ConfigLoadResult {
  const warnings: string[] = [];
  const config = defaultConfig();
  if (raw.length > MAX_CONFIG_BYTES) {
    return { config, warnings: ['.credkeeper.json is larger than 64 KB and was ignored.'] };
  }
  let parsed: unknown;
  try {
    // Reviver drops prototype-polluting keys.
    parsed = JSON.parse(raw, (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v));
  } catch {
    return { config, warnings: ['.credkeeper.json is not valid JSON and was ignored.'] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { config, warnings: ['.credkeeper.json must be a JSON object and was ignored.'] };
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) warnings.push(`Unknown key "${sanitize(key)}" in .credkeeper.json was ignored.`);
  }

  if (obj.disabledRules !== undefined) {
    for (const id of stringArray(obj.disabledRules, 'disabledRules', 50, warnings)) {
      if (!ALL_RULE_IDS.has(id)) warnings.push(`Unknown rule "${sanitize(id)}" in disabledRules was ignored.`);
      else if (UNDISABLEABLE.has(id)) warnings.push(`Rule ${id} is critical and cannot be disabled by repository config.`);
      else config.disabledRules.add(id);
    }
    if (config.disabledRules.size > 3) {
      warnings.push(`.credkeeper.json disables ${config.disabledRules.size} rules. Check this is intentional.`);
    }
  }

  if (obj.allowlist !== undefined) {
    for (const h of stringArray(obj.allowlist, 'allowlist', 500, warnings)) {
      if (/^[0-9a-f]{64}$/.test(h)) config.allowlist.add(h);
      else warnings.push('An allowlist entry is not a SHA-256 hex hash and was ignored. Use "credkeeper hash".');
    }
  }

  if (obj.excludePaths !== undefined) {
    for (const g of stringArray(obj.excludePaths, 'excludePaths', 50, warnings)) {
      const re = globToRegExp(g);
      if (re) config.excludePaths.push(re);
      else warnings.push(`Exclude pattern "${sanitize(g)}" is too complex and was ignored.`);
    }
  }

  if (obj.maxFileSizeKB !== undefined) {
    const n = obj.maxFileSizeKB;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 20480) config.maxFileSizeBytes = n * 1024;
    else warnings.push('maxFileSizeKB must be an integer between 1 and 20480; default used.');
  }
  return { config, warnings };
}

function stringArray(v: unknown, name: string, max: number, warnings: string[]): string[] {
  if (!Array.isArray(v)) {
    warnings.push(`${name} must be an array of strings and was ignored.`);
    return [];
  }
  const out = v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200);
  if (out.length !== v.length) warnings.push(`Some ${name} entries were not short strings and were ignored.`);
  if (out.length > max) warnings.push(`${name} has more than ${max} entries; extra entries ignored.`);
  return out.slice(0, max);
}

/** Minimal glob: ** = any path, * = any chars except '/', ? = one char. Limited to keep matching linear. */
export function globToRegExp(glob: string): RegExp | null {
  if (glob.length > 200) return null;
  const stars = (glob.match(/\*/g) ?? []).length;
  if (stars > 6) return null;
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const anchored = glob.includes('/') ? `^${re.replace(/^\//, '')}(?:/.*)?$` : `(?:^|/)${re}(?:/.*)?$`;
  return new RegExp(anchored);
}

function sanitize(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '?').slice(0, 60);
}
