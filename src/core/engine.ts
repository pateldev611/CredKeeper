import { Finding, FindingLocation, NotebookModel, ScanWarning, Severity, SEVERITY_ORDER } from './types';
import { PATTERN_RULES, FILE_RULES } from './rules';
import { CredKeeperConfig, defaultConfig } from './config';
import { EnvIndex, allowlistHash } from './envIndex';
import { mask } from './mask';
import { classify, FileKind } from './files';
import { parseNotebook } from './notebook';

const MAX_LINE = 10_000;
const LINE_OVERLAP = 300;
const FILE_BUDGET_MS = 500;
const IGNORE = /credkeeper:ignore(?:[ \t]+([A-Z0-9, \t]{1,100}))?/;

export interface EngineOptions {
  config?: CredKeeperConfig;
  envIndex?: EnvIndex;
}

export interface ContentScan {
  findings: Finding[];
  warnings: ScanWarning[];
}

interface RawHit {
  ruleId: string;
  title: string;
  severity: Severity;
  start: number;
  end: number;
  masked: string;
  message: string;
  fix: string;
  envVar?: string;
}

export class Engine {
  readonly config: CredKeeperConfig;
  readonly envIndex: EnvIndex;

  constructor(opts: EngineOptions = {}) {
    this.config = opts.config ?? defaultConfig();
    this.envIndex = opts.envIndex ?? new EnvIndex();
  }

  /** Scan any file's content, dispatching on file type. Never throws. */
  scanContent(file: string, content: string): ContentScan {
    const kind = classify(file);
    const warnings: ScanWarning[] = [];
    try {
      if (kind === 'env' || kind === 'unsupported') return { findings: [], warnings };
      if (kind === 'notebook') {
        const parsed = parseNotebook(content);
        parsed.warnings.forEach(message => warnings.push({ file, message }));
        if (parsed.model) {
          const r = this.scanNotebook(file, parsed.model);
          return { findings: r.findings, warnings: warnings.concat(r.warnings) };
        }
        return this.withWarnings(this.scanText(file, content, 'code', { kind: 'file' }), warnings);
      }
      return this.withWarnings(this.scanText(file, content, kind, { kind: 'file' }), warnings);
    } catch {
      warnings.push({ file, message: 'Scanner error on this file; it was skipped.' });
      return { findings: [], warnings };
    }
  }

  /** Scan a normalised notebook (from JSON or from a live VS Code NotebookDocument). */
  scanNotebook(file: string, model: NotebookModel): ContentScan {
    const findings: Finding[] = [];
    const warnings: ScanWarning[] = [];
    const deadline = Date.now() + FILE_BUDGET_MS * 2;
    model.cells.forEach((cell, ci) => {
      const srcKind = cell.kind === 'markdown' ? 'markdown' : 'code';
      const r = this.scanText(file, cell.source, 'code', { kind: srcKind, cell: ci }, deadline);
      findings.push(...r.findings);
      warnings.push(...r.warnings);
      cell.outputs.forEach((out, oi) => {
        const ro = this.scanText(file, out.text, 'code', { kind: 'output', cell: ci, output: oi, outputType: out.outputType }, deadline, false);
        findings.push(...ro.findings);
        warnings.push(...ro.warnings);
      });
    });
    return { findings, warnings: dedupeWarnings(warnings) };
  }

  /** Scan one text segment line by line. */
  scanText(file: string, text: string, kind: FileKind, location: FindingLocation, deadline = Date.now() + FILE_BUDGET_MS, honorIgnore = true): ContentScan {
    const findings: Finding[] = [];
    const warnings: ScanWarning[] = [];
    const lines = text.split(/\r?\n/);
    const isTemplate = kind === 'env-template';
    for (let i = 0; i < lines.length; i++) {
      if (Date.now() > deadline) {
        warnings.push({ file, message: `Scan time limit reached; lines after ${i} were not scanned.` });
        break;
      }
      const line = lines[i];
      let ignored: Set<string> | 'all' | null = null;
      if (honorIgnore) {
        const ig = IGNORE.exec(line);
        if (ig) ignored = ig[1] ? new Set(ig[1].split(/[\s,]+/).filter(Boolean)) : 'all';
      }
      if (ignored === 'all') continue;
      for (const hit of this.scanLine(line, kind, isTemplate)) {
        if (ignored && ignored.has(hit.ruleId)) continue;
        findings.push({
          ruleId: hit.ruleId, title: hit.title, severity: hit.severity, file,
          line: i + 1, column: hit.start, endColumn: hit.end,
          masked: hit.masked, message: hit.message, fix: hit.fix,
          location: { ...location }, envVar: hit.envVar,
        });
      }
    }
    return { findings, warnings };
  }

  private scanLine(line: string, kind: FileKind, isTemplate: boolean): RawHit[] {
    const hits: RawHit[] = [];
    // Long lines are scanned in overlapping chunks so a padded line can't hide a secret or stall a regex.
    for (let off = 0; off < Math.max(1, line.length); off += MAX_LINE - LINE_OVERLAP) {
      const chunk = line.slice(off, off + MAX_LINE);
      this.patternHits(chunk, kind, isTemplate).forEach(h => hits.push({ ...h, start: h.start + off, end: h.end + off }));
      this.envHits(chunk, isTemplate).forEach(h => hits.push({ ...h, start: h.start + off, end: h.end + off }));
      if (off + MAX_LINE >= line.length) break;
    }
    return resolveOverlaps(hits);
  }

  private patternHits(chunk: string, kind: FileKind, isTemplate: boolean): RawHit[] {
    const out: RawHit[] = [];
    for (const rule of PATTERN_RULES) {
      if (this.config.disabledRules.has(rule.id)) continue;
      if (rule.configOnly && kind !== 'config' && !isTemplate) continue;
      try {
        rule.pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        let guard = 0;
        while ((m = rule.pattern.exec(chunk)) !== null && guard++ < 200) {
          if (m[0].length === 0) { rule.pattern.lastIndex++; continue; }
          const value = m[rule.group] ?? m[0];
          if (rule.validate && !rule.validate(value, chunk, Array.from(m, g => g ?? ''))) continue;
          if (this.config.allowlist.has(allowlistHash(value))) continue;
          const start = m.index + m[0].indexOf(value);
          out.push({
            ruleId: rule.id, title: rule.title, severity: rule.severity,
            start, end: start + value.length, masked: mask(value), message: rule.message, fix: rule.fix,
          });
        }
      } catch {
        // A failing rule must never stop the others.
      } finally {
        rule.pattern.lastIndex = 0;
      }
    }
    return out;
  }

  private envHits(chunk: string, isTemplate: boolean): RawHit[] {
    const rule = isTemplate ? FILE_RULES.R20 : FILE_RULES.R19;
    if (this.config.disabledRules.has(rule.id)) return [];
    return this.envIndex.match(chunk).map(m => ({
      ruleId: rule.id, title: rule.title, severity: rule.severity,
      start: m.start, end: m.end,
      masked: `value of ${m.varName}`,
      message: isTemplate
        ? `This template contains the real value of ${m.varName} from your .env file.`
        : `The value of ${m.varName} from your .env file appears here, so the secret has escaped .env.`,
      fix: isTemplate ? `Blank it: ${m.varName}=` : `Use os.environ["${m.varName}"] instead, or clear this output.`,
      envVar: m.varName,
    }));
  }

  private withWarnings(r: ContentScan, extra: ScanWarning[]): ContentScan {
    return { findings: r.findings, warnings: extra.concat(r.warnings) };
  }
}

/** When hits overlap, keep the most severe; ties go to the more specific (lower-numbered) rule. */
function resolveOverlaps(hits: RawHit[]): RawHit[] {
  const sorted = [...hits].sort((a, b) =>
    SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || a.ruleId.localeCompare(b.ruleId) || a.start - b.start);
  const kept: RawHit[] = [];
  for (const h of sorted) {
    if (!kept.some(k => h.start < k.end && k.start < h.end)) kept.push(h);
  }
  return kept.sort((a, b) => a.start - b.start);
}

function dedupeWarnings(ws: ScanWarning[]): ScanWarning[] {
  const seen = new Set<string>();
  return ws.filter(w => (seen.has(w.message) ? false : (seen.add(w.message), true)));
}
