import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  Engine, EnvIndex, Finding, NotebookModel, NotebookOutputModel, SEVERITY_ORDER,
  cleanOutputText, scanWorkspace, loadConfig, findEnvFiles, buildEnvIndex, defaultConfig,
  resolveInside, classify, FILE_RULES, excluded,
} from '../core';
import { isGitRepo, isIgnored } from '../core/git';
import { FindingsTree, StoredFile } from './tree';

const DEBOUNCE_MS = 300;
const MAX_DOC_CHARS = 2 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: false });

/** What a diagnostic was built from, so quick fixes can act on it. */
interface Entry {
  finding: Finding;
  range: vscode.Range;
  kind: 'text' | 'cell' | 'output';
  notebook?: vscode.NotebookDocument;
  cellIndex?: number;
}

let diagnostics: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let tree: FindingsTree;
const engines = new Map<string, Engine>();
const entriesByUri = new Map<string, Entry[]>();
const cellUrisByNotebook = new Map<string, string[]>();
const timers = new Map<string, NodeJS.Timeout>();
/** All findings shown in the tree, keyed by file system path. */
const store = new Map<string, StoredFile>();

export function activate(ctx: vscode.ExtensionContext): void {
  diagnostics = vscode.languages.createDiagnosticCollection('credkeeper');
  output = vscode.window.createOutputChannel('CredKeeper');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'credkeeperFindings.focus';
  tree = new FindingsTree(store);

  ctx.subscriptions.push(
    diagnostics, output, statusBar,
    vscode.window.registerTreeDataProvider('credkeeperFindings', tree),
    vscode.commands.registerCommand('credkeeper.scanWorkspace', scanAllFolders),
    vscode.commands.registerCommand('credkeeper.reveal', reveal),
    vscode.languages.registerCodeActionsProvider(
      [{ scheme: 'file' }, { scheme: 'untitled' }, { scheme: 'vscode-notebook-cell' }],
      new QuickFixes(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),

    vscode.workspace.onDidOpenTextDocument(d => scheduleText(d)),
    vscode.workspace.onDidChangeTextDocument(e => scheduleText(e.document)),
    vscode.workspace.onDidCloseTextDocument(d => { if (!isCellDoc(d)) clearUri(d.uri); }),
    vscode.workspace.onDidOpenNotebookDocument(nb => scheduleNotebook(nb)),
    vscode.workspace.onDidChangeNotebookDocument(e => scheduleNotebook(e.notebook)),
    vscode.workspace.onDidSaveNotebookDocument(nb => scheduleNotebook(nb)),
    vscode.workspace.onDidCloseNotebookDocument(nb => clearNotebook(nb)),
    vscode.workspace.onDidGrantWorkspaceTrust(() => resetAndRescan('Workspace trusted: config and env-aware mode enabled.')),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('credkeeper')) rescanOpen(); }),
  );

  // .env files and repo config change what we detect: rebuild and rescan.
  const watcher = vscode.workspace.createFileSystemWatcher('**/{.env,.env.*,*.env,.credkeeper.json}');
  const onEnv = () => resetAndRescan();
  ctx.subscriptions.push(watcher, watcher.onDidChange(onEnv), watcher.onDidCreate(onEnv), watcher.onDidDelete(onEnv));

  if (!vscode.workspace.isTrusted) {
    output.appendLine('Restricted mode: scanning only. .credkeeper.json, env-aware mode and quick fixes are disabled.');
  }
  rescanOpen();
}

export function deactivate(): void {
  timers.forEach(t => clearTimeout(t));
}

// ---------- engines ----------

function folderFor(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(uri);
}

function engineFor(uri: vscode.Uri): Engine {
  const folder = folderFor(uri);
  if (!folder || folder.uri.scheme !== 'file') return new Engine();
  const key = folder.uri.toString();
  let engine = engines.get(key);
  if (!engine) {
    const root = folder.uri.fsPath;
    const trusted = vscode.workspace.isTrusted;
    const cfg = trusted ? loadConfig(root) : { config: defaultConfig(), warnings: [] };
    cfg.warnings.forEach(w => output.appendLine(`[${folder.name}] ${w}`));
    const env = trusted ? buildEnvIndex(root, findEnvFiles(root)) : new EnvIndex();
    if (env.size > 0) output.appendLine(`[${folder.name}] Env-aware mode tracking ${env.size} secret value(s) from .env files.`);
    engine = new Engine({ config: cfg.config, envIndex: env });
    engines.set(key, engine);
  }
  return engine;
}

function resetAndRescan(message?: string): void {
  engines.clear();
  if (message) output.appendLine(message);
  rescanOpen();
}

function rescanOpen(): void {
  vscode.workspace.textDocuments.forEach(d => scheduleText(d));
  vscode.workspace.notebookDocuments.forEach(nb => scheduleNotebook(nb));
}

// ---------- scheduling ----------

function debounce(key: string, fn: () => void): void {
  const prev = timers.get(key);
  if (prev) clearTimeout(prev);
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    try { fn(); } catch { output.appendLine('Scan failed for one document; it was skipped.'); }
  }, DEBOUNCE_MS));
}

function isCellDoc(d: vscode.TextDocument): boolean {
  return d.uri.scheme === 'vscode-notebook-cell';
}

function scheduleText(doc: vscode.TextDocument): void {
  if (isCellDoc(doc)) {
    const nb = notebookOfCell(doc);
    if (nb) scheduleNotebook(nb);
    return;
  }
  if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') return;
  if (doc.fileName.endsWith('.ipynb')) return; // handled by the notebook editor
  debounce(doc.uri.toString(), () => scanTextDocument(doc));
}

function scheduleNotebook(nb: vscode.NotebookDocument): void {
  if (nb.uri.scheme !== 'file' && nb.uri.scheme !== 'untitled') return;
  debounce(nb.uri.toString(), () => scanNotebookDocument(nb));
}

function notebookOfCell(doc: vscode.TextDocument): vscode.NotebookDocument | undefined {
  return vscode.workspace.notebookDocuments.find(nb => nb.getCells().some(c => c.document === doc));
}

// ---------- scanning ----------

function relName(uri: vscode.Uri, languageId?: string): string {
  if (uri.scheme === 'untitled') {
    const ext: Record<string, string> = { python: '.py', sql: '.sql', yaml: '.yaml', json: '.json', shellscript: '.sh' };
    return 'untitled' + (ext[languageId ?? ''] ?? '.txt');
  }
  const folder = folderFor(uri);
  return folder ? path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/') : path.basename(uri.fsPath);
}

function visible(f: Finding): boolean {
  const showLow = vscode.workspace.getConfiguration('credkeeper').get<boolean>('showLowSeverity', false);
  return showLow || SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER.medium;
}

function scanTextDocument(doc: vscode.TextDocument): void {
  if (doc.isClosed) return;
  const rel = relName(doc.uri, doc.languageId);
  if (classify(rel) === 'unsupported') return;
  const engine = engineFor(doc.uri);
  if (excluded(engine.config, rel)) return;
  const text = doc.getText();
  if (text.length > MAX_DOC_CHARS) return;
  const result = engine.scanContent(rel, text);
  const findings = result.findings.filter(visible);
  const r18 = envNotIgnored(doc, rel);
  if (r18) findings.push(r18);
  const entries: Entry[] = findings.map(f => ({ finding: f, range: rangeIn(doc, f.line - 1, f.column, f.endColumn), kind: 'text' }));
  entriesByUri.set(doc.uri.toString(), entries);
  diagnostics.set(doc.uri, entries.map(toDiagnostic));
  if (doc.uri.scheme === 'file') setStore(doc.uri, findings, false);
}

/** R18 live: an open .env file that Git would not ignore. */
function envNotIgnored(doc: vscode.TextDocument, rel: string): Finding | undefined {
  const folder = folderFor(doc.uri);
  if (!folder || doc.uri.scheme !== 'file' || classify(rel) !== 'env') return undefined;
  const root = folder.uri.fsPath;
  if (!isGitRepo(root) || isIgnored(root, rel)) return undefined;
  const r = FILE_RULES.R18;
  return { ruleId: r.id, title: r.title, severity: r.severity, file: rel, line: 1, column: 0, endColumn: 0, masked: '', message: r.message, fix: r.fix, location: { kind: 'file' } };
}

function notebookModel(nb: vscode.NotebookDocument): NotebookModel {
  return {
    cells: nb.getCells().map(c => ({
      kind: c.kind === vscode.NotebookCellKind.Code ? 'code' as const : 'markdown' as const,
      source: c.document.getText().slice(0, MAX_DOC_CHARS),
      outputs: c.outputs.flatMap(readOutput),
    })),
  };
}

function readOutput(o: vscode.NotebookCellOutput): NotebookOutputModel[] {
  const out: NotebookOutputModel[] = [];
  for (const item of o.items) {
    if (/^(?:image|video|audio)\//.test(item.mime) || item.mime.startsWith('application/vnd.jupyter.widget')) continue;
    if (item.data.byteLength > MAX_DOC_CHARS) continue;
    let text = decoder.decode(item.data);
    let type = item.mime;
    if (item.mime === 'application/vnd.code.notebook.error') {
      try {
        const e = JSON.parse(text) as Record<string, unknown>;
        text = ['name', 'message', 'stack'].map(k => e[k]).filter((v): v is string => typeof v === 'string').join('\n');
      } catch { /* keep raw text */ }
      type = 'error';
    } else if (item.mime === 'application/vnd.code.notebook.stdout' || item.mime === 'application/vnd.code.notebook.stderr') {
      type = 'stream';
    }
    out.push({ outputType: type, text: cleanOutputText(text) });
  }
  return out;
}

function scanNotebookDocument(nb: vscode.NotebookDocument): void {
  if (nb.isClosed) return;
  const rel = relName(nb.uri);
  const engine = engineFor(nb.uri);
  if (excluded(engine.config, rel)) return;
  const result = engine.scanNotebook(rel, notebookModel(nb));
  const findings = result.findings.filter(visible);
  const byCell = new Map<number, Entry[]>();
  for (const f of findings) {
    const ci = f.location.cell ?? 0;
    if (ci >= nb.cellCount) continue;
    const cellDoc = nb.cellAt(ci).document;
    const entry: Entry = f.location.kind === 'output'
      ? { finding: f, range: rangeIn(cellDoc, 0, 0, Number.MAX_SAFE_INTEGER), kind: 'output', notebook: nb, cellIndex: ci }
      : { finding: f, range: rangeIn(cellDoc, f.line - 1, f.column, f.endColumn), kind: 'cell', notebook: nb, cellIndex: ci };
    byCell.set(ci, [...(byCell.get(ci) ?? []), entry]);
  }
  const nowUris: string[] = [];
  nb.getCells().forEach((cell, i) => {
    const uri = cell.document.uri;
    nowUris.push(uri.toString());
    const entries = byCell.get(i) ?? [];
    entriesByUri.set(uri.toString(), entries);
    diagnostics.set(uri, entries.map(toDiagnostic));
  });
  // Clear diagnostics for cells that no longer exist.
  for (const old of cellUrisByNotebook.get(nb.uri.toString()) ?? []) {
    if (!nowUris.includes(old)) { diagnostics.delete(vscode.Uri.parse(old)); entriesByUri.delete(old); }
  }
  cellUrisByNotebook.set(nb.uri.toString(), nowUris);
  if (nb.uri.scheme === 'file') setStore(nb.uri, findings, true);
}

function clearUri(uri: vscode.Uri): void {
  diagnostics.delete(uri);
  entriesByUri.delete(uri.toString());
}

function clearNotebook(nb: vscode.NotebookDocument): void {
  for (const u of cellUrisByNotebook.get(nb.uri.toString()) ?? []) clearUri(vscode.Uri.parse(u));
  cellUrisByNotebook.delete(nb.uri.toString());
}

function rangeIn(doc: vscode.TextDocument, line: number, start: number, end: number): vscode.Range {
  if (doc.lineCount === 0) return new vscode.Range(0, 0, 0, 0);
  const l = Math.min(Math.max(0, line), doc.lineCount - 1);
  const len = doc.lineAt(l).text.length;
  const s = Math.min(start, len);
  const e = end <= start ? len : Math.min(end, len);
  return new vscode.Range(l, s, l, Math.max(s, e));
}

function toDiagnostic(e: Entry): vscode.Diagnostic {
  const f = e.finding;
  const prefix = e.kind === 'output' ? `Output of this cell (${f.location.outputType}) leaks a secret. ` : '';
  const value = f.masked ? ` [${f.masked}]` : '';
  const d = new vscode.Diagnostic(e.range, `${prefix}${f.title}${value}: ${f.message}\nFix: ${f.fix}`,
    f.severity === 'critical' || f.severity === 'high' ? vscode.DiagnosticSeverity.Error
      : f.severity === 'medium' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
  d.source = 'CredKeeper';
  d.code = f.ruleId;
  return d;
}

// ---------- tree + status ----------

function setStore(uri: vscode.Uri, findings: Finding[], notebook: boolean): void {
  if (findings.length === 0) store.delete(uri.fsPath);
  else store.set(uri.fsPath, { uri, findings, notebook });
  refreshViews();
}

function refreshViews(): void {
  tree.refresh();
  let total = 0, critical = 0;
  store.forEach(s => s.findings.forEach(f => { total++; if (f.severity === 'critical' || f.severity === 'high') critical++; }));
  statusBar.text = total === 0 ? '$(shield) CredKeeper' : `$(warning) CredKeeper: ${total}`;
  statusBar.tooltip = total === 0 ? 'No secrets found in scanned files' : `${total} finding(s), ${critical} high or critical. Click to view.`;
  statusBar.backgroundColor = critical > 0 ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
  statusBar.show();
}

async function scanAllFolders(): Promise<void> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file');
  if (folders.length === 0) { vscode.window.showInformationMessage('CredKeeper: open a folder to scan the workspace.'); return; }
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'CredKeeper: scanning workspace' }, async () => {
    let total = 0, files = 0;
    for (const folder of folders) {
      const root = folder.uri.fsPath;
      const result = scanWorkspace(root, { trusted: vscode.workspace.isTrusted });
      result.warnings.forEach(w => output.appendLine(`[${folder.name}] ${w.file ? w.file + ': ' : ''}${w.message}`));
      files += result.filesScanned;
      for (const k of [...store.keys()]) if (k.startsWith(root + path.sep)) store.delete(k);
      const byFile = new Map<string, Finding[]>();
      for (const f of result.findings.filter(visible)) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
      for (const [rel, fs_] of byFile) {
        const uri = vscode.Uri.file(path.join(root, rel));
        store.set(uri.fsPath, { uri, findings: fs_, notebook: rel.endsWith('.ipynb') });
        total += fs_.length;
      }
    }
    rescanOpen(); // open documents keep live, exact-position results
    refreshViews();
    vscode.window.showInformationMessage(total === 0
      ? `CredKeeper: no secrets found in ${files} files.`
      : `CredKeeper: ${total} finding(s). See the CredKeeper Findings view.`);
  });
}

async function reveal(uri: vscode.Uri, f: Finding): Promise<void> {
  if (uri.fsPath.endsWith('.ipynb')) {
    const nb = await vscode.workspace.openNotebookDocument(uri);
    const cell = Math.min(f.location.cell ?? 0, Math.max(0, nb.cellCount - 1));
    const editor = await vscode.window.showNotebookDocument(nb, { selections: [new vscode.NotebookRange(cell, cell + 1)] });
    editor.revealRange(new vscode.NotebookRange(cell, cell + 1), vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  const range = rangeIn(doc, f.line - 1, f.column, f.endColumn);
  await vscode.window.showTextDocument(doc, { selection: range });
}

// ---------- quick fixes ----------

const COMMENT: Record<string, string> = {
  python: '#', yaml: '#', shellscript: '#', r: '#', dockerfile: '#', makefile: '#', toml: '#', properties: '#', ini: '#', dotenv: '#', powershell: '#',
  sql: '--', javascript: '//', typescript: '//', java: '//', csharp: '//', scala: '//', go: '//',
};

/** How to read an environment variable in each supported language, and the import it needs (if any). */
interface EnvAccess {
  expr: (name: string) => string;
  importLine?: string;
  hasImport?: (text: string) => boolean;
}

const ENV_ACCESS: Record<string, EnvAccess> = {
  python: {
    expr: name => `os.environ["${name}"]`,
    importLine: 'import os',
    hasImport: text => /^\s*(?:import\s+(?:[\w.]+\s*,\s*)*os\b|from\s+os\s+import\b)/m.test(text),
  },
  javascript: { expr: name => `process.env.${name}` },
  typescript: { expr: name => `process.env.${name}` },
  java: { expr: name => `System.getenv("${name}")` },
  csharp: {
    expr: name => `Environment.GetEnvironmentVariable("${name}")`,
    importLine: 'using System;',
    hasImport: text => /^\s*using\s+System\s*;/m.test(text),
  },
  go: {
    expr: name => `os.Getenv("${name}")`,
    importLine: 'import "os"',
    hasImport: text => /\bimport\b[\s\S]{0,200}?"os"/.test(text),
  },
  scala: { expr: name => `sys.env("${name}")` },
  r: { expr: name => `Sys.getenv("${name}")` },
  shellscript: { expr: name => `"$${name}"` },
  powershell: { expr: name => `$env:${name}` },
};

class QuickFixes implements vscode.CodeActionProvider {
  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    if (!vscode.workspace.isTrusted) return []; // no edits in restricted mode
    const entries = entriesByUri.get(doc.uri.toString()) ?? [];
    const actions: vscode.CodeAction[] = [];
    for (const diag of ctx.diagnostics) {
      if (diag.source !== 'CredKeeper') continue;
      const e = entries.find(x => x.range.isEqual(diag.range) && x.finding.ruleId === diag.code);
      if (!e) continue;
      const add = (a: vscode.CodeAction | undefined) => { if (a) { a.diagnostics = [diag]; actions.push(a); } };
      if (e.kind === 'output') add(clearOutputAction(e));
      else {
        add(moveToEnvAction(doc, e));
        add(blankTemplateAction(doc, e));
        add(gitignoreAction(doc, e));
        add(ignoreLineAction(doc, e));
      }
    }
    return actions;
  }
}

function clearOutputAction(e: Entry): vscode.CodeAction | undefined {
  const nb = e.notebook, i = e.cellIndex;
  if (!nb || i === undefined || i >= nb.cellCount) return undefined;
  const cell = nb.cellAt(i);
  const data = new vscode.NotebookCellData(cell.kind, cell.document.getText(), cell.document.languageId);
  data.metadata = cell.metadata;
  data.outputs = [];
  const a = new vscode.CodeAction("CredKeeper: Clear this cell's outputs", vscode.CodeActionKind.QuickFix);
  a.edit = new vscode.WorkspaceEdit();
  a.edit.set(nb.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(i, i + 1), [data])]);
  a.isPreferred = true;
  return a;
}

function moveToEnvAction(doc: vscode.TextDocument, e: Entry): vscode.CodeAction | undefined {
  const f = e.finding;
  const access = ENV_ACCESS[doc.languageId];
  if (!access || f.ruleId === 'R20' || f.ruleId === 'R18') return undefined;
  const line = doc.lineAt(e.range.start.line).text;
  const s = e.range.start.character, end = e.range.end.character;
  const q = line[s - 1];
  if ((q !== '"' && q !== "'") || line[end] !== q) return undefined; // value must be a whole string literal
  const root = rootOf(doc, e);
  if (!root) return undefined;
  const envPath = resolveInside(root, '.env', p => fs.realpathSync(p));
  if (!envPath) return undefined;

  const existing = readIfExists(envPath);
  const name = f.envVar ?? uniqueName(deriveName(line.slice(0, s - 1), f.ruleId), existing);
  const a = new vscode.CodeAction(`CredKeeper: Move to environment variable ${name}`, vscode.CodeActionKind.QuickFix);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(e.range.start.line, s - 1, e.range.start.line, end + 1), access.expr(name));
  if (access.importLine && !hasRequiredImport(doc, e, access)) insertImport(edit, doc, access.importLine);

  if (!f.envVar) {
    // Value moves into .env (its proper home); it is read from the document now, never stored by CredKeeper.
    const value = doc.getText(new vscode.Range(e.range.start.line, s, e.range.start.line, end));
    appendLine(edit, envPath, existing, `${name}=${envQuote(value)}`);
  }
  const gi = path.join(root, '.gitignore');
  if (isGitRepo(root) && !isIgnored(root, path.relative(root, envPath).split(path.sep).join('/'))) {
    appendLine(edit, gi, readIfExists(gi), '.env');
  }
  a.edit = edit;
  a.isPreferred = true;
  return a;
}

function blankTemplateAction(doc: vscode.TextDocument, e: Entry): vscode.CodeAction | undefined {
  if (e.finding.ruleId !== 'R20') return undefined;
  const a = new vscode.CodeAction(`CredKeeper: Blank ${e.finding.envVar ?? 'this'} value in template`, vscode.CodeActionKind.QuickFix);
  a.edit = new vscode.WorkspaceEdit();
  a.edit.replace(doc.uri, e.range, '');
  a.isPreferred = true;
  return a;
}

function gitignoreAction(doc: vscode.TextDocument, e: Entry): vscode.CodeAction | undefined {
  if (e.finding.ruleId !== 'R18') return undefined;
  const root = rootOf(doc, e);
  if (!root) return undefined;
  const gi = path.join(root, '.gitignore');
  const rel = path.relative(root, doc.uri.fsPath).split(path.sep).join('/');
  const a = new vscode.CodeAction(`CredKeeper: Add ${rel} to .gitignore`, vscode.CodeActionKind.QuickFix);
  a.edit = new vscode.WorkspaceEdit();
  appendLine(a.edit, gi, readIfExists(gi), rel);
  return a;
}

function ignoreLineAction(doc: vscode.TextDocument, e: Entry): vscode.CodeAction | undefined {
  const c = COMMENT[doc.languageId];
  if (!c || e.finding.ruleId === 'R19' || e.finding.severity === 'critical') return undefined; // critical leaks must be fixed, not hidden
  const line = doc.lineAt(e.range.start.line);
  const a = new vscode.CodeAction(`CredKeeper: Ignore ${e.finding.ruleId} on this line (false positive)`, vscode.CodeActionKind.QuickFix);
  a.edit = new vscode.WorkspaceEdit();
  a.edit.insert(doc.uri, line.range.end, `  ${c} credkeeper:ignore ${e.finding.ruleId}`);
  return a;
}

// ---------- helpers ----------

function rootOf(doc: vscode.TextDocument, e: Entry): string | undefined {
  const uri = e.notebook?.uri ?? doc.uri;
  const folder = folderFor(uri);
  return folder && folder.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
}

function hasRequiredImport(doc: vscode.TextDocument, e: Entry, access: EnvAccess): boolean {
  if (!access.hasImport) return true;
  if (e.notebook) return e.notebook.getCells().some(c => c.kind === vscode.NotebookCellKind.Code && access.hasImport!(c.document.getText()));
  return access.hasImport(doc.getText());
}

/** Go's package clause must stay the first statement, so "import" goes after it there; elsewhere, at the top of the file. */
function insertImport(edit: vscode.WorkspaceEdit, doc: vscode.TextDocument, importLine: string): void {
  if (doc.languageId === 'go') {
    const m = /^package\s+\w+.*$/m.exec(doc.getText());
    if (m) {
      edit.insert(doc.uri, doc.positionAt(m.index + m[0].length), `\n\n${importLine}`);
      return;
    }
  }
  edit.insert(doc.uri, new vscode.Position(0, 0), importLine + '\n');
}

function deriveName(before: string, ruleId: string): string {
  const m = /["']?([A-Za-z_][A-Za-z0-9_]{0,60})["']?\s*(?:=|:)\s*[rbfuRBFU]?$/.exec(before.trimEnd());
  const raw = m ? m[1] : `CREDKEEPER_${ruleId}`;
  const name = raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return /^[A-Z_][A-Z0-9_]*$/.test(name) ? name : `CREDKEEPER_${ruleId}`;
}

function uniqueName(name: string, envContent: string | null): string {
  const taken = new Set((envContent ?? '').split(/\r?\n/).map(l => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1]).filter(Boolean));
  let n = name, i = 2;
  while (taken.has(n)) n = `${name}_${i++}`;
  return n;
}

function envQuote(v: string): string {
  return /^[A-Za-z0-9_\-.\/+=@:]*$/.test(v) ? v : `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function readIfExists(p: string): string | null {
  try { return fs.lstatSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null; } catch { return null; }
}

/** Append a line to a file through the WorkspaceEdit, so it can be undone. Creates the file if missing. */
function appendLine(edit: vscode.WorkspaceEdit, file: string, content: string | null, line: string): void {
  const uri = vscode.Uri.file(file);
  if (content === null) {
    edit.createFile(uri, { ignoreIfExists: true });
    edit.insert(uri, new vscode.Position(0, 0), line + '\n');
    return;
  }
  if (content.split(/\r?\n/).some(l => l.trim() === line.trim())) return;
  const lines = content.split('\n');
  const last = lines.length - 1;
  const prefix = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  edit.insert(uri, new vscode.Position(last, lines[last].length), `${prefix}${line}\n`);
}
