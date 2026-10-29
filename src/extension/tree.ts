import * as vscode from 'vscode';
import * as path from 'path';
import { Finding, Severity } from '../core';

export interface StoredFile {
  uri: vscode.Uri;
  findings: Finding[];
  notebook: boolean;
}

type Node =
  | { type: 'severity'; severity: Severity; count: number }
  | { type: 'file'; severity: Severity; file: StoredFile; findings: Finding[] }
  | { type: 'finding'; file: StoredFile; finding: Finding };

const LEVELS: Severity[] = ['critical', 'high', 'medium', 'low'];
const ICON: Record<Severity, string> = { critical: 'error', high: 'error', medium: 'warning', low: 'info' };

/** Findings grouped by severity, then file. Native tree view: no webview, no HTML injection surface. */
export class FindingsTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: Map<string, StoredFile>) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    const files = [...this.store.values()];
    if (!node) {
      return LEVELS
        .map(severity => ({ type: 'severity' as const, severity, count: files.reduce((n, f) => n + f.findings.filter(x => x.severity === severity).length, 0) }))
        .filter(n => n.count > 0);
    }
    if (node.type === 'severity') {
      return files
        .map(file => ({ type: 'file' as const, severity: node.severity, file, findings: file.findings.filter(f => f.severity === node.severity) }))
        .filter(n => n.findings.length > 0)
        .sort((a, b) => a.file.uri.fsPath.localeCompare(b.file.uri.fsPath));
    }
    if (node.type === 'file') return node.findings.map(finding => ({ type: 'finding' as const, file: node.file, finding }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === 'severity') {
      const item = new vscode.TreeItem(`${node.severity[0].toUpperCase()}${node.severity.slice(1)} (${node.count})`, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(ICON[node.severity]);
      return item;
    }
    if (node.type === 'file') {
      const label = vscode.workspace.asRelativePath(node.file.uri, false);
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
      item.resourceUri = node.file.uri;
      item.description = `${node.findings.length}`;
      return item;
    }
    const f = node.finding;
    const where = f.location.kind === 'output' ? `cell ${f.location.cell! + 1} output`
      : f.location.cell !== undefined ? `cell ${f.location.cell + 1}, line ${f.line}` : `line ${f.line}`;
    const item = new vscode.TreeItem(`${f.ruleId} ${f.title}`, vscode.TreeItemCollapsibleState.None);
    item.description = `${where}${f.masked ? '  ' + f.masked : ''}`;
    item.tooltip = new vscode.MarkdownString().appendText(`${f.message}\n\nFix: ${f.fix}`); // appendText escapes content
    item.iconPath = new vscode.ThemeIcon(ICON[f.severity]);
    item.command = { command: 'credkeeper.reveal', title: 'Open', arguments: [node.file.uri, f] };
    return item;
  }
}

export function basename(p: string): string {
  return path.basename(p);
}
