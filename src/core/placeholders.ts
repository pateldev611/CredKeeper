const PLACEHOLDER = /^(?:x+|\*+|\.+|changeme|change_me|change-me|password|passw0rd|secret|token|example|sample|dummy|test|testing|null|none|undefined|true|false|todo|tbd|redacted|placeholder|your[-_ ].*|my[-_ ].*|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%\([^)]*\)s|\$[A-Z_][A-Z0-9_]*)$/i;
// Anchored to the start: a real reference expression always opens with one of these, so a
// secret can't be waved through by appending e.g. "_os.environ" as a decoy suffix.
const REFERENCES = /^(?:os\.environ|os\.getenv|getenv\(|dbutils\.secrets|process\.env|\$\{\{\s*secrets\.|keyvault|key_vault|secretmanager)/i;

/** Values that are obviously not real secrets: placeholders, env references, templating. */
export function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return true;
  if (PLACEHOLDER.test(v)) return true;
  if (REFERENCES.test(v)) return true;
  // Same character repeated, e.g. "aaaaaaaa" or "00000000"
  if (/^(.)\1+$/.test(v)) return true;
  return false;
}
