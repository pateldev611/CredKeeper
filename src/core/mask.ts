/**
 * Central masking. Every value that reaches a UI, log, report or error message
 * must pass through here. Shows at most the first 4 characters.
 */
export function mask(value: string): string {
  if (value.length <= 8) return '*'.repeat(Math.max(4, value.length));
  return value.slice(0, 4) + '*'.repeat(Math.min(12, value.length - 4));
}

/** Strip terminal colour codes (common in Jupyter tracebacks) so they can't split a secret. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]{0,32}[ -\/]{0,4}[@-~]/g, '');
}
