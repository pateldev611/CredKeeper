export type Severity = 'critical' | 'high' | 'medium' | 'low';

export const SEVERITY_ORDER: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Where in a file a finding sits. Notebooks add cell and output detail. */
export interface FindingLocation {
  kind: 'code' | 'markdown' | 'output' | 'file';
  /** 0-based cell index, notebooks only. */
  cell?: number;
  /** 0-based output index within the cell, outputs only. */
  output?: number;
  /** Jupyter output type or MIME type, outputs only. */
  outputType?: string;
}

export interface Finding {
  ruleId: string;
  title: string;
  severity: Severity;
  file: string;
  /** 1-based line within the segment (file, cell source or output). */
  line: number;
  /** 0-based column range within the line. */
  column: number;
  endColumn: number;
  /** Masked value. Never the raw secret. */
  masked: string;
  message: string;
  fix: string;
  location: FindingLocation;
  /** For env-aware findings: the .env variable whose value leaked. */
  envVar?: string;
}

export interface ScanWarning {
  file?: string;
  message: string;
}

export interface ScanResult {
  findings: Finding[];
  warnings: ScanWarning[];
  filesScanned: number;
}

/** A normalised notebook, built from .ipynb JSON (CLI) or a VS Code NotebookDocument (extension). */
export interface NotebookModel {
  cells: NotebookCellModel[];
}

export interface NotebookCellModel {
  kind: 'code' | 'markdown' | 'raw';
  source: string;
  outputs: NotebookOutputModel[];
}

export interface NotebookOutputModel {
  outputType: string;
  text: string;
}
