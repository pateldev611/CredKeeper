/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ONLY = /^[0-9a-f]+$/i;
const PATHLIKE = /^[A-Za-z0-9_.\-]+(\/[A-Za-z0-9_.\-]+)+$/;

/** True for strings that look random enough to be a key and aren't a known benign shape. */
export function looksHighEntropy(s: string): boolean {
  if (s.length < 20) return false;
  if (UUID.test(s) || HEX_ONLY.test(s) || PATHLIKE.test(s)) return false;
  if (!/[0-9]/.test(s) || !/[A-Za-z]/.test(s)) return false;
  return shannonEntropy(s) > 4.0;
}
