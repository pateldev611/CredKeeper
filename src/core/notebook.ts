import { NotebookModel, NotebookCellModel, NotebookOutputModel } from './types';
import { stripAnsi } from './mask';

const MAX_OUTPUT_CHARS = 200_000;
const MAX_CELLS = 5_000;
const SKIP_MIME = /^(?:image\/|video\/|audio\/|application\/vnd\.jupyter\.widget|application\/pdf)/;

export interface NotebookParseResult {
  model: NotebookModel | null;
  warnings: string[];
}

/** Parse .ipynb JSON into a NotebookModel. Never throws; malformed parts are skipped. */
export function parseNotebook(raw: string): NotebookParseResult {
  const warnings: string[] = [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { model: null, warnings: ['Notebook is not valid JSON; scanned as plain text instead.'] };
  }
  const cellsRaw = (json as { cells?: unknown })?.cells;
  if (!Array.isArray(cellsRaw)) {
    return { model: null, warnings: ['Notebook has no cells array; scanned as plain text instead.'] };
  }
  if (cellsRaw.length > MAX_CELLS) warnings.push(`Notebook has more than ${MAX_CELLS} cells; extra cells skipped.`);
  const cells: NotebookCellModel[] = [];
  for (const c of cellsRaw.slice(0, MAX_CELLS)) {
    if (typeof c !== 'object' || c === null) {
      cells.push({ kind: 'raw', source: '', outputs: [] });
      continue;
    }
    const cell = c as Record<string, unknown>;
    const kind = cell.cell_type === 'code' ? 'code' : cell.cell_type === 'markdown' ? 'markdown' : 'raw';
    const outputs: NotebookOutputModel[] = [];
    if (Array.isArray(cell.outputs)) {
      for (const o of cell.outputs) {
        const out = readOutput(o);
        if (out) outputs.push(out);
      }
    }
    cells.push({ kind, source: joinText(cell.source), outputs });
  }
  return { model: { cells }, warnings };
}

function readOutput(o: unknown): NotebookOutputModel | null {
  if (typeof o !== 'object' || o === null) return null;
  const out = o as Record<string, unknown>;
  const type = typeof out.output_type === 'string' ? out.output_type : 'unknown';
  let text = '';
  if (type === 'stream') {
    text = joinText(out.text);
  } else if (type === 'error') {
    const tb = Array.isArray(out.traceback) ? out.traceback.map(String).join('\n') : '';
    text = [str(out.ename), str(out.evalue), tb].filter(Boolean).join('\n');
  } else if (typeof out.data === 'object' && out.data !== null) {
    const parts: string[] = [];
    for (const [mime, value] of Object.entries(out.data as Record<string, unknown>)) {
      if (SKIP_MIME.test(mime)) continue;
      parts.push(typeof value === 'string' || Array.isArray(value) ? joinText(value) : safeStringify(value));
    }
    text = parts.join('\n');
  }
  return { outputType: type, text: clean(text) };
}

/** Normalise output text from any source: strip ANSI codes, cap size. Used by the extension too. */
export function clean(text: string): string {
  const t = stripAnsi(text);
  return t.length > MAX_OUTPUT_CHARS ? t.slice(0, MAX_OUTPUT_CHARS) : t;
}

function joinText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.filter(x => typeof x === 'string').join('');
  return '';
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/** Clear outputs of the given cells in raw .ipynb JSON. Returns null if the notebook can't be parsed. */
export function clearOutputs(raw: string, cellIndexes: Set<number>): string | null {
  let json: { cells?: unknown };
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || !Array.isArray(json.cells)) return null;
  json.cells.forEach((c, i) => {
    if (cellIndexes.has(i) && c && typeof c === 'object' && (c as Record<string, unknown>).cell_type === 'code') {
      (c as Record<string, unknown>).outputs = [];
      (c as Record<string, unknown>).execution_count = null;
    }
  });
  const indent = /^\{\n( +)"/.exec(raw)?.[1].length ?? 1;
  return JSON.stringify(json, null, indent) + '\n';
}
