import { Severity } from './types';
import { isPlaceholder } from './placeholders';
import { looksHighEntropy } from './entropy';

export interface PatternRule {
  id: string;
  title: string;
  severity: Severity;
  /** Must be global. Must be linear-time safe: no nested or overlapping unbounded quantifiers. */
  pattern: RegExp;
  /** Capture group holding the secret value. 0 = whole match. */
  group: number;
  /** Extra check on the value and full line; return false to drop the match. */
  validate?: (value: string, line: string, groups: string[]) => boolean;
  /** Only run on config-style files (.yaml, .properties, ...). */
  configOnly?: boolean;
  message: string;
  fix: string;
}

const SECRET_NAME = /(?:password|passwd|pwd|pass|secret|token|api_?key|apikey|access_?key|private_?key|client_?secret|auth_?key|credential)/i;
const NOT_SECRET_NAME = /(?:_url|_uri|_path|_file|_name|_id|_type|_len|_length|_field|_header|_prompt|_label|_policy|_endpoint|_expiry|_expires|_ttl)$/i;

export function nameLooksSecret(name: string): boolean {
  return SECRET_NAME.test(name) && !NOT_SECRET_NAME.test(name);
}

export const PATTERN_RULES: PatternRule[] = [
  {
    id: 'R01', title: 'Private key block', severity: 'critical',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g, group: 0,
    message: 'A private key is embedded in this file. Anyone with it can impersonate the key owner.',
    fix: 'Remove the key, store it in a secret manager or a file outside the repo, and rotate it.',
  },
  {
    id: 'R02', title: 'AWS access key ID', severity: 'critical',
    pattern: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g, group: 1,
    message: 'An AWS access key ID is hardcoded. Paired with its secret, it grants access to the AWS account.',
    fix: 'Read it from an environment variable or AWS profile, and deactivate this key in IAM.',
  },
  {
    id: 'R03', title: 'AWS secret access key', severity: 'critical',
    pattern: /aws_?secret_?access_?key["']?\s{0,5}[:=]\s{0,5}["']?([A-Za-z0-9\/+=]{40})(?![A-Za-z0-9\/+=])/gi, group: 1,
    validate: v => !isPlaceholder(v),
    message: 'An AWS secret access key is hardcoded.',
    fix: 'Move it to an environment variable or AWS profile, and rotate the key in IAM.',
  },
  {
    id: 'R04', title: 'Databricks personal access token', severity: 'critical',
    pattern: /\b(dapi[0-9a-f]{32})(?:-\d)?\b/g, group: 1,
    message: 'A Databricks personal access token is hardcoded. It grants workspace access as its owner.',
    fix: 'Use dbutils.secrets.get(scope, key) or an environment variable, and revoke this token in Databricks.',
  },
  {
    id: 'R05', title: 'Azure storage account key', severity: 'critical',
    pattern: /AccountKey=([A-Za-z0-9+\/]{86}==)/g, group: 1,
    message: 'An Azure storage account key is hardcoded. It gives full access to the storage account.',
    fix: 'Use a managed identity or Key Vault, and regenerate this key in the Azure portal.',
  },
  {
    id: 'R06', title: 'Azure SAS token', severity: 'high',
    pattern: /[?&]sig=([A-Za-z0-9%+\/=]{20,200})/g, group: 1,
    validate: (_v, line) => /[?&]sv=/.test(line) && /[?&]se=/.test(line),
    message: 'An Azure shared access signature (SAS) token is in this URL.',
    fix: 'Generate SAS tokens at runtime with short expiry, and revoke this one.',
  },
  {
    id: 'R07', title: 'Spark config credential', severity: 'critical',
    pattern: /spark\.conf\.set\(\s{0,5}["']fs\.azure\.account\.(?:key|oauth2\.client\.secret)[^"'\n]{0,200}["']\s{0,5},\s{0,5}["']([^"'\n]{8,300})["']/g, group: 1,
    validate: v => !isPlaceholder(v),
    message: 'A storage credential is set as a literal in Spark config.',
    fix: 'Use dbutils.secrets.get(scope, key) as the value instead of a literal.',
  },
  {
    id: 'R08', title: 'Snowflake connection credential', severity: 'high',
    pattern: /snowflake:\/\/[^:\s\/@"']{1,100}:([^@\s"']{4,200})@/gi, group: 1,
    validate: v => !isPlaceholder(v),
    message: 'A Snowflake password is embedded in a connection URL.',
    fix: 'Build the URL from environment variables, or use key-pair or SSO authentication.',
  },
  {
    id: 'R09', title: 'JDBC / ODBC connection password', severity: 'high',
    pattern: /(?:jdbc:[^\s"']{0,300}|Driver=[^"'\n]{0,300})[;&?](?:password|pwd)=([^;&\s"']{4,200})/gi, group: 1,
    validate: v => !isPlaceholder(v),
    message: 'A database password is embedded in a JDBC/ODBC connection string.',
    fix: 'Pass the password separately from an environment variable or secret store.',
  },
  {
    id: 'R10', title: 'Database URI with credentials', severity: 'high',
    pattern: /\b(?:postgres(?:ql)?|mysql|mariadb|mssql|sqlserver|oracle|mongodb(?:\+srv)?|rediss?|amqps?)(?:\+[a-z0-9]{1,20})?:\/\/[^:\s\/@"']{1,100}:([^@\s\/"']{3,200})@/gi, group: 1,
    validate: v => !isPlaceholder(v),
    message: 'A database password is embedded in a connection URI.',
    fix: 'Build the URI from environment variables at runtime.',
  },
  {
    id: 'R11', title: 'GitHub token', severity: 'high',
    pattern: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,255})\b/g, group: 1,
    message: 'A GitHub token is hardcoded.',
    fix: 'Use an environment variable or the CI secret store, and revoke this token on GitHub.',
  },
  {
    id: 'R12', title: 'Slack token', severity: 'medium',
    pattern: /\b(xox[abprs]-[A-Za-z0-9-]{10,200})/g, group: 1,
    message: 'A Slack token is hardcoded.',
    fix: 'Move it to an environment variable and revoke it in Slack app settings.',
  },
  {
    id: 'R13', title: 'Google API key', severity: 'high',
    pattern: /\b(AIza[0-9A-Za-z_\-]{35})(?![0-9A-Za-z_\-])/g, group: 1,
    message: 'A Google API key is hardcoded.',
    fix: 'Move it to an environment variable, restrict it, and regenerate it in Google Cloud.',
  },
  {
    id: 'R14', title: 'AI provider API key', severity: 'high',
    pattern: /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,200})/g, group: 1,
    validate: v => /[0-9]/.test(v) && /[A-Za-z]/.test(v.slice(3)),
    message: 'An AI provider API key is hardcoded.',
    fix: 'Move it to an environment variable and rotate it in the provider console.',
  },
  {
    id: 'R15', title: 'JSON Web Token', severity: 'medium',
    pattern: /\b(eyJ[A-Za-z0-9_\-]{10,2000}\.eyJ[A-Za-z0-9_\-]{10,4000}\.[A-Za-z0-9_\-]{10,1000})/g, group: 1,
    message: 'A JSON Web Token is present. It may grant a live session.',
    fix: 'Do not store tokens in code or outputs; clear the output or remove the token.',
  },
  {
    id: 'R16', title: 'Hardcoded password or secret', severity: 'medium',
    // name = "value" / name: 'value' / name="value" in code and quoted config
    pattern: /([A-Za-z_][A-Za-z0-9_.\-]{0,60})["']?\s{0,5}(?:=|:|=>)\s{0,5}[rbfu]?["']([^"'\n]{8,200})["']/g, group: 2,
    validate: (v, _line, g) => nameLooksSecret(g[1]) && !isPlaceholder(v) && !/\s{2,}/.test(v) && !/^[A-Za-z]+( [A-Za-z]+)+$/.test(v),
    message: 'A password or secret is assigned as a literal string.',
    fix: 'Read it from an environment variable (os.environ["NAME"]) or a secret store.',
  },
  {
    id: 'R16', title: 'Hardcoded password or secret', severity: 'medium',
    // unquoted config: password: value / password=value, with an optional trailing comment
    pattern: /^\s{0,40}([A-Za-z_][A-Za-z0-9_.\-]{0,60})\s{0,5}[:=]\s{0,5}([^\s"'#]{8,200})(?:[ \t]{1,20}[#;].{0,200})?\s{0,10}$/g, group: 2,
    configOnly: true,
    validate: (v, _line, g) => nameLooksSecret(g[1]) && !isPlaceholder(v),
    message: 'A password or secret is stored as a literal in a config file.',
    fix: 'Reference an environment variable or secret store instead of the literal value.',
  },
  {
    id: 'R21', title: 'Stripe API key', severity: 'critical',
    pattern: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,99})\b/g, group: 1,
    message: 'A Stripe API key is hardcoded. It can move money or access customer data.',
    fix: 'Move it to an environment variable and roll the key in the Stripe dashboard.',
  },
  {
    id: 'R22', title: 'SendGrid API key', severity: 'high',
    pattern: /\b(SG\.[A-Za-z0-9_\-]{16,32}\.[A-Za-z0-9_\-]{16,64})\b/g, group: 1,
    message: 'A SendGrid API key is hardcoded.',
    fix: 'Move it to an environment variable and revoke it in the SendGrid dashboard.',
  },
  {
    id: 'R23', title: 'Chat webhook URL with embedded token', severity: 'high',
    pattern: /\bhttps:\/\/(?:hooks\.slack\.com\/services\/[A-Za-z0-9\/]{20,60}|discord(?:app)?\.com\/api\/webhooks\/\d{10,25}\/[A-Za-z0-9_\-]{20,100}|[A-Za-z0-9-]{1,60}\.webhook\.office\.com\/webhookb2\/[A-Za-z0-9\-@\/]{20,200})\b/gi, group: 0,
    message: 'A chat webhook URL contains an embedded token. Anyone with this URL can post as this integration.',
    fix: 'Move it to an environment variable or secret store, and regenerate the webhook if it has leaked.',
  },
  {
    id: 'R17', title: 'High-entropy string', severity: 'low',
    pattern: /["']([A-Za-z0-9+\/=_\-.]{20,200})["']/g, group: 1,
    validate: v => looksHighEntropy(v) && !isPlaceholder(v),
    message: 'This string looks random enough to be a key or token.',
    fix: 'If it is a credential, move it to an environment variable; otherwise add "credkeeper:ignore R17".',
  },
];

export const FILE_RULES = {
  R18: {
    id: 'R18', title: '.env file not ignored by Git', severity: 'medium' as Severity,
    message: 'This .env file is not covered by .gitignore, so it can be committed by accident.',
    fix: 'Add this file (or a pattern such as .env*) to .gitignore.',
  },
  R19: {
    id: 'R19', title: '.env value found outside .env', severity: 'critical' as Severity,
    message: 'The value of a variable from your .env file appears here, so the secret has escaped .env.',
    fix: 'Replace it with a reference to the environment variable, or clear the notebook output.',
  },
  R20: {
    id: 'R20', title: 'Real value in .env template', severity: 'high' as Severity,
    message: 'This template file contains a real value from your .env file. Templates are usually committed.',
    fix: 'Blank the value in the template, e.g. NAME=',
  },
};

/** Critical rules cannot be disabled by repository config. */
export const UNDISABLEABLE = new Set(
  [...PATTERN_RULES.filter(r => r.severity === 'critical').map(r => r.id), 'R19'],
);

export const ALL_RULE_IDS = new Set([...PATTERN_RULES.map(r => r.id), 'R18', 'R19', 'R20']);
