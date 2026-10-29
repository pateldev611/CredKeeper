// @ts-nocheck
// Loads the compiled extension with a minimal stub of the `vscode` module, so activation,
// live scanning and quick fixes are exercised without launching VS Code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import Module from 'module';
import { FAKE, tmpDir, write, gitInit } from './fixtures';

const handlers: Record<string, Function[]> = {};
const diag = new Map<string, any[]>();
let codeActionProvider: any;
let trusted = true;
const root = tmpDir('lg-ext-');
gitInit(root);
// Loaded once, by the first engineFor() call below, so it must exist before that happens.
write(root, '.credkeeper.json', JSON.stringify({ excludePaths: ['excluded-secret.py'] }));

class Position { constructor(public line: number, public character: number) {} }
class Range {
  start: Position; end: Position;
  constructor(a: any, b: any, c?: any, d?: any) {
    if (a instanceof Position) { this.start = a; this.end = b; } else { this.start = new Position(a, b); this.end = new Position(c, d); }
  }
  isEqual(o: Range) { return this.start.line === o.start.line && this.start.character === o.start.character && this.end.line === o.end.line && this.end.character === o.end.character; }
}
class Uri {
  constructor(public scheme: string, public fsPath: string, public frag = '') {}
  static file(p: string) { return new Uri('file', p); }
  static parse(s: string) { const [scheme, rest] = s.split('://'); return new Uri(scheme, rest); }
  toString() { return `${this.scheme}://${this.fsPath}${this.frag}`; }
}
class WorkspaceEdit {
  ops: any[] = [];
  replace(uri: Uri, range: Range, text: string) { this.ops.push({ op: 'replace', uri: uri.toString(), range, text }); }
  insert(uri: Uri, pos: Position, text: string) { this.ops.push({ op: 'insert', uri: uri.toString(), pos, text }); }
  createFile(uri: Uri) { this.ops.push({ op: 'create', uri: uri.toString() }); }
  set(uri: Uri, edits: any[]) { this.ops.push({ op: 'set', uri: uri.toString(), edits }); }
}
const on = (name: string) => (fn: Function) => { (handlers[name] ??= []).push(fn); return { dispose() {} }; };
const disposable = { dispose() {} };

const vscodeStub = {
  Position, Range, Uri, WorkspaceEdit,
  Diagnostic: class { source?: string; code?: string; constructor(public range: Range, public message: string, public severity: number) {} },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  CodeAction: class { edit?: WorkspaceEdit; diagnostics?: any[]; isPreferred?: boolean; constructor(public title: string, public kind: any) {} },
  CodeActionKind: { QuickFix: 'quickfix' },
  NotebookCellKind: { Markup: 1, Code: 2 },
  NotebookCellData: class { metadata: any; outputs: any[] = []; constructor(public kind: number, public value: string, public languageId: string) {} },
  NotebookRange: class { constructor(public start: number, public end: number) {} },
  NotebookEdit: { replaceCells: (range: any, cells: any[]) => ({ range, cells }) },
  NotebookEditorRevealType: { InCenterIfOutsideViewport: 2 },
  StatusBarAlignment: { Left: 1 },
  ProgressLocation: { Notification: 15 },
  ThemeIcon: class { constructor(public id: string) {} },
  ThemeColor: class { constructor(public id: string) {} },
  MarkdownString: class { v = ''; appendText(t: string) { this.v += t; return this; } },
  TreeItem: class { constructor(public label: string, public collapsibleState: number) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class { event = () => disposable; fire() {} },
  languages: {
    createDiagnosticCollection: () => ({
      set: (uri: Uri, d: any[]) => diag.set(uri.toString(), d), delete: (uri: Uri) => diag.delete(uri.toString()), dispose() {},
    }),
    registerCodeActionsProvider: (_s: any, p: any) => { codeActionProvider = p; return disposable; },
  },
  window: {
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    registerTreeDataProvider: () => disposable,
    showInformationMessage() {}, withProgress: (_o: any, fn: Function) => fn(),
  },
  commands: { registerCommand: () => disposable },
  workspace: {
    get isTrusted() { return trusted; },
    textDocuments: [] as any[], notebookDocuments: [] as any[],
    workspaceFolders: [{ uri: Uri.file(root), name: 'test', index: 0 }],
    getWorkspaceFolder: (uri: Uri) => (uri.fsPath.startsWith(root) ? { uri: Uri.file(root), name: 'test', index: 0 } : undefined),
    getConfiguration: () => ({ get: (_k: string, d: any) => d }),
    createFileSystemWatcher: () => ({ onDidChange: () => disposable, onDidCreate: () => disposable, onDidDelete: () => disposable, dispose() {} }),
    asRelativePath: (u: Uri) => path.relative(root, u.fsPath),
    onDidOpenTextDocument: on('openText'), onDidChangeTextDocument: on('changeText'), onDidCloseTextDocument: on('closeText'),
    onDidOpenNotebookDocument: on('openNb'), onDidChangeNotebookDocument: on('changeNb'), onDidSaveNotebookDocument: on('saveNb'),
    onDidCloseNotebookDocument: on('closeNb'), onDidGrantWorkspaceTrust: on('trust'), onDidChangeConfiguration: on('config'),
  },
};

const origLoad = (Module as any)._load;
(Module as any)._load = function (req: string, ...rest: any[]) { return req === 'vscode' ? vscodeStub : origLoad.call(this, req, ...rest); };
const ext = require('../src/extension/extension');

function textDoc(file: string, text: string, languageId = 'python', scheme = 'file', frag = '') {
  const lines = text.split('\n');
  return {
    uri: new Uri(scheme, file, frag), fileName: file, languageId, isClosed: false, lineCount: lines.length,
    getText: (r?: Range) => (r ? lines[r.start.line].slice(r.start.character, r.end.character) : text),
    lineAt: (i: number) => ({ text: lines[i], range: new Range(i, 0, i, lines[i].length) }),
    positionAt: (offset: number) => {
      let remaining = offset;
      for (let i = 0; i < lines.length; i++) {
        if (remaining <= lines[i].length) return new Position(i, remaining);
        remaining -= lines[i].length + 1;
      }
      return new Position(lines.length - 1, lines[lines.length - 1].length);
    },
  };
}
const wait = (ms = 400) => new Promise(r => setTimeout(r, ms));
const enc = new TextEncoder();

test('extension activates without throwing', () => {
  ext.activate({ subscriptions: [] });
  assert.ok(codeActionProvider, 'code action provider registered');
});

test('live scan: a hardcoded secret in a .py file produces an error diagnostic with masked value', async () => {
  const doc = textDoc(path.join(root, 'app.py'), `token = "${FAKE.github}"\nx = 1`);
  handlers.openText.forEach(h => h(doc));
  await wait();
  const d = diag.get(doc.uri.toString())!;
  assert.equal(d.length, 1);
  assert.equal(d[0].code, 'R11');
  assert.equal(d[0].severity, 0);
  assert.ok(!d[0].message.includes(FAKE.github));
  assert.equal(d[0].range.start.character, 9);
});

test('excludePaths in .credkeeper.json suppresses live editor diagnostics too, not just the batch scan', async () => {
  const doc = textDoc(path.join(root, 'excluded-secret.py'), `token = "${FAKE.github}"`);
  handlers.openText.forEach(h => h(doc));
  await wait();
  const d = diag.get(doc.uri.toString());
  assert.ok(!d || d.length === 0, 'an excluded file should produce no live diagnostics');
});

test('quick fix: move to environment variable rewrites the literal, adds import os, .env entry and .gitignore', async () => {
  const doc = textDoc(path.join(root, 'conn.py'), `password = "${FAKE.dbPassword}"`);
  handlers.openText.forEach(h => h(doc));
  await wait();
  const d = diag.get(doc.uri.toString())!;
  const actions = codeActionProvider.provideCodeActions(doc, d[0].range, { diagnostics: d });
  const move = actions.find((a: any) => a.title.includes('Move to environment variable PASSWORD'));
  assert.ok(move, actions.map((a: any) => a.title).join(' | '));
  const ops = move.edit.ops;
  assert.ok(ops.some((o: any) => o.op === 'replace' && o.text === 'os.environ["PASSWORD"]'));
  assert.ok(ops.some((o: any) => o.op === 'insert' && o.text === 'import os\n'));
  assert.ok(ops.some((o: any) => o.uri.endsWith('.env') && o.text?.startsWith('PASSWORD=')));
  assert.ok(ops.some((o: any) => o.uri.endsWith('.gitignore') && o.text === '.env\n'));
});

test('quick fix: move to environment variable works in TypeScript, with no import needed', async () => {
  const doc = textDoc(path.join(root, 'conn.ts'), `const databaseSecret = "${FAKE.dbPassword}";`, 'typescript');
  handlers.openText.forEach(h => h(doc));
  await wait();
  const d = diag.get(doc.uri.toString())!;
  const actions = codeActionProvider.provideCodeActions(doc, d[0].range, { diagnostics: d });
  const move = actions.find((a: any) => a.title.startsWith('CredKeeper: Move to environment variable'));
  assert.ok(move, actions.map((a: any) => a.title).join(' | '));
  const ops = move.edit.ops;
  assert.ok(ops.some((o: any) => o.op === 'replace' && /^process\.env\.[A-Z_]+$/.test(o.text)));
  assert.ok(!ops.some((o: any) => o.op === 'insert' && o.uri === doc.uri.toString()), 'no import line needed for TS');
  assert.ok(ops.some((o: any) => o.uri.endsWith('.env')));
});

test('quick fix: move to environment variable in Go inserts "import \\"os\\"" after the package clause', async () => {
  const doc = textDoc(path.join(root, 'conn.go'), `package main\n\nconst dbSecret = "${FAKE.dbPassword}"`, 'go');
  handlers.openText.forEach(h => h(doc));
  await wait();
  const d = diag.get(doc.uri.toString())!;
  const actions = codeActionProvider.provideCodeActions(doc, d[0].range, { diagnostics: d });
  const move = actions.find((a: any) => a.title.startsWith('CredKeeper: Move to environment variable'));
  assert.ok(move, actions.map((a: any) => a.title).join(' | '));
  const ops = move.edit.ops;
  assert.ok(ops.some((o: any) => o.op === 'replace' && /^os\.Getenv\("[A-Z_]+"\)$/.test(o.text)));
  const imp = ops.find((o: any) => o.op === 'insert' && o.uri === doc.uri.toString());
  assert.ok(imp, 'import inserted');
  assert.ok(imp.text.includes('import "os"'));
  assert.equal(imp.pos.line, 0, 'inserted right after the package line, not before it');
});

test('notebook: secret in a cell output is flagged on that cell and can be cleared', async () => {
  const cellDocs = [
    textDoc(path.join(root, 'nb.ipynb'), 'import os\nconfig = load()', 'python', 'vscode-notebook-cell', '#c0'),
    textDoc(path.join(root, 'nb.ipynb'), 'print(config)', 'python', 'vscode-notebook-cell', '#c1'),
  ];
  const outputs = [[], [{ items: [{ mime: 'application/vnd.code.notebook.stdout', data: enc.encode(`{'password': '${FAKE.snowPassword}'}`) }] }]];
  const cells = cellDocs.map((document, i) => ({ kind: 2, document, outputs: outputs[i], metadata: {} }));
  const nb = { uri: Uri.file(path.join(root, 'nb.ipynb')), isClosed: false, cellCount: 2, getCells: () => cells, cellAt: (i: number) => cells[i] };
  handlers.openNb.forEach(h => h(nb));
  await wait();
  assert.equal(diag.get(cellDocs[0].uri.toString())!.length, 0, 'clean cell');
  const d = diag.get(cellDocs[1].uri.toString())!;
  assert.equal(d.length, 1);
  assert.match(d[0].message, /Output of this cell/);
  const actions = codeActionProvider.provideCodeActions(cellDocs[1], d[0].range, { diagnostics: d });
  const clear = actions.find((a: any) => a.title.includes("Clear this cell's outputs"));
  assert.ok(clear);
  assert.equal(clear.edit.ops[0].edits[0].cells[0].outputs.length, 0);
});

test('notebook error output (traceback) is scanned', async () => {
  const cellDoc = textDoc(path.join(root, 'err.ipynb'), 'connect()', 'python', 'vscode-notebook-cell', '#c0');
  const err = JSON.stringify({ name: 'OperationalError', message: `postgresql://admin:${FAKE.dbPassword}@db`, stack: '' });
  const cells = [{ kind: 2, document: cellDoc, outputs: [{ items: [{ mime: 'application/vnd.code.notebook.error', data: enc.encode(err) }] }], metadata: {} }];
  const nb = { uri: Uri.file(path.join(root, 'err.ipynb')), isClosed: false, cellCount: 1, getCells: () => cells, cellAt: (i: number) => cells[i] };
  handlers.openNb.forEach(h => h(nb));
  await wait();
  assert.equal(diag.get(cellDoc.uri.toString())![0].code, 'R10');
});

test('restricted mode: no quick fixes are offered', async () => {
  const doc = textDoc(path.join(root, 'r.py'), `password = "${FAKE.dbPassword}"`);
  handlers.openText.forEach(h => h(doc));
  await wait();
  trusted = false;
  const d = diag.get(doc.uri.toString())!;
  assert.equal(codeActionProvider.provideCodeActions(doc, d[0].range, { diagnostics: d }).length, 0);
  trusted = true;
});

test('critical findings cannot be silenced with an ignore comment quick fix', async () => {
  const doc = textDoc(path.join(root, 'k.py'), `key = "${FAKE.aws}"`);
  handlers.openText.forEach(h => h(doc));
  await wait();
  const d = diag.get(doc.uri.toString())!;
  const titles = codeActionProvider.provideCodeActions(doc, d[0].range, { diagnostics: d }).map((a: any) => a.title);
  assert.ok(!titles.some((t: string) => t.includes('Ignore')), titles.join(' | '));
});

test('open .env not covered by .gitignore gets R18 live', async () => {
  write(root, '.env', `DB_PASSWORD=${FAKE.envPassword}\n`);
  write(root, '.gitignore', 'node_modules\n');
  const doc = textDoc(path.join(root, '.env'), `DB_PASSWORD=${FAKE.envPassword}`, 'dotenv');
  handlers.openText.forEach(h => h(doc));
  await wait();
  const d = diag.get(doc.uri.toString())!;
  assert.equal(d[0].code, 'R18');
  const actions = codeActionProvider.provideCodeActions(doc, d[0].range, { diagnostics: d });
  assert.ok(actions.some((a: any) => a.title.includes('Add .env to .gitignore')));
});
