import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * Fake secrets are assembled from fragments at runtime so this repository never contains
 * secret-shaped strings (which would trip GitHub push protection and company scanners).
 */
export const FAKE = {
  aws: 'AK' + 'IA' + 'IOSFODNN7' + 'EXAMPLE',
  awsSecret: 'wJalrXUtnFEMI' + '/K7MDENG/bPxRfiCY' + 'EXAMPLEKEY',  // credkeeper:ignore R16  // leakguard:ignore R16
  databricks: 'da' + 'pi' + '0123456789abcdef'.repeat(2),
  github: 'gh' + 'p_' + 'A1b2C3d4'.repeat(4) + 'E5f6',
  slack: 'xo' + 'xb-' + '1234567890-abcdefGHIJ',
  google: 'AI' + 'za' + 'SyD3fAk3K3y-0123456789_abcdefghijkl',
  aiKey: 's' + 'k-proj-' + 'Fak3Key0123456789abcdefXYZ',
  azureKey: 'Fak3' + 'A'.repeat(78) + 'b9Z0' + '==',
  jwt: 'ey' + 'JhbGciOiJIUzI1NiJ9.' + 'ey' + 'JzdWIiOiIxMjM0NTY3ODkwIn0.' + 'Fak3SignatureAbc123',
  dbPassword: 'FakePass_123!',  // credkeeper:ignore R16  // leakguard:ignore R16
  snowPassword: 'Sn0wFake#2026',  // credkeeper:ignore R16  // leakguard:ignore R16
  envPassword: 'Tr0ub4dor_Fake_2026',  // credkeeper:ignore R16
  customToken: 'Blue#Tiger2026',  // credkeeper:ignore R16
  privateKeyHeader: '-----BEGIN ' + 'RSA PRIVATE KEY-----',  // credkeeper:ignore R16
};

export function allFakeValues(): string[] {
  return Object.values(FAKE);
}

export function tmpDir(prefix = 'lg-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function write(root: string, rel: string, content: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

export function gitInit(root: string): void {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
}

export function notebook(cells: Array<{ source: string; outputs?: unknown[]; type?: string }>): string {
  return JSON.stringify({
    nbformat: 4, nbformat_minor: 5, metadata: {},
    cells: cells.map(c => ({ cell_type: c.type ?? 'code', metadata: {}, source: c.source.split(/(?<=\n)/), outputs: c.outputs ?? [], execution_count: c.outputs?.length ? 1 : null })),
  }, null, 1);
}

export const stream = (text: string) => ({ output_type: 'stream', name: 'stdout', text: text.split(/(?<=\n)/) });
export const errorOut = (evalue: string, tb: string[]) => ({ output_type: 'error', ename: 'OperationalError', evalue, traceback: tb });
export const result = (plain: string) => ({ output_type: 'execute_result', execution_count: 1, metadata: {}, data: { 'text/plain': plain } });

/** Builds the full demo/test corpus on disk. Returns the root. */
export function buildCorpus(root = tmpDir('lg-corpus-')): string {
  write(root, 'positive/app.py', [
    `aws_key = "${FAKE.aws}"`,
    `aws_secret_access_key = "${FAKE.awsSecret}"`,
    `db_url = "postgresql://admin:${FAKE.dbPassword}@db.example.com:5432/sales"`,
    `token = "${FAKE.github}"`,
    `slack = "${FAKE.slack}"`,
    `maps = "${FAKE.google}"`,
    `client = OpenAI(api_key="${FAKE.aiKey}")`,
    `session = "${FAKE.jwt}"`,
    `PRIVATE = """${FAKE.privateKeyHeader}`,
  ].join('\n'));
  write(root, 'positive/spark_setup.py', [
    `spark.conf.set("fs.azure.account.key.mystore.dfs.core.windows.net", "${FAKE.azureKey}")`,
    `DATABRICKS_TOKEN = "${FAKE.databricks}"`,
  ].join('\n'));
  write(root, 'positive/connect.sql', `-- jdbc:sqlserver://srv.example.com:1433;database=sales;user=etl;password=${FAKE.dbPassword}`);  // credkeeper:ignore R09
  write(root, 'positive/settings.yaml', `database:\n  host: db.example.com\n  password: ${FAKE.dbPassword}\n`);
  write(root, 'positive/storage.json', JSON.stringify({ conn: `DefaultEndpointsProtocol=https;AccountName=x;AccountKey=${FAKE.azureKey};EndpointSuffix=core.windows.net` }));
  write(root, 'positive/sas.py', `url = "https://x.blob.core.windows.net/c?sv=2022-11-02&se=2026-12-01&sp=r&sig=Fak3SigAbc123DEF456ghi789%3D"`);
  write(root, 'positive/snow.py', `engine = create_engine("snowflake://etl_user:${FAKE.snowPassword}@myorg/db")`);
  write(root, 'positive/explore.ipynb', notebook([
    { source: 'import os\nconfig = load_config()\n', outputs: [] },
    { source: 'print(config)\n', outputs: [stream(`{'user': 'etl', 'password': '${FAKE.snowPassword}'}\n`)] },
    { source: 'conn = connect()\n', outputs: [errorOut(`could not connect to postgresql://admin:${FAKE.dbPassword}@db.example.com`, ['\u001b[0;31mOperationalError\u001b[0m', `\u001b[0;32mpostgresql://admin:${FAKE.dbPassword}@db\u001b[0m`])] },
    { source: 'token\n', outputs: [result(`'${FAKE.databricks}'`)] },
  ]));

  write(root, 'negative/safe.py', [
    'import os',
    'password = os.environ["DB_PASSWORD"]',
    'token = "<your-token-here>"',
    'api_key = "changeme"',
    'secret = "${SECRET}"',
    'password_field = "password"',
    'request_id = "123e4567-e89b-12d3-a456-426614174000"',
    'sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"',
    'path = "src/core/engine/rules/files.ts"',
    'msg = "Please enter your password below"',
    'key = dbutils.secrets.get(scope="kv", key="storage")',
  ].join('\n'));
  write(root, 'negative/config.yaml', 'database:\n  host: db.example.com\n  password: ${DB_PASSWORD}\n  port: 5432\n');
  write(root, 'negative/clean.ipynb', notebook([{ source: 'print("hello")\n', outputs: [stream('hello\n')] }]));
  return root;
}
