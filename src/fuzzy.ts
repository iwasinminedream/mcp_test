/**
 * Levenshtein edit distance with an early-exit ceiling. Returns `max + 1` as soon
 * as it can prove the true distance exceeds `max`, which makes the common
 * "not even close" case very cheap during a full-pool fuzzy scan.
 */
export function boundedLevenshtein(a: string, b: string, max: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (la === 0) return lb <= max ? lb : max + 1;
  if (lb === 0) return la <= max ? la : max + 1;

  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[lb]! <= max ? prev[lb]! : max + 1;
}

/** Normalized similarity in [0, 1] derived from bounded edit distance. */
export function similarity(a: string, b: string, max: number): number {
  const d = boundedLevenshtein(a, b, max);
  const longest = Math.max(a.length, b.length, 1);
  if (d > max) return 0;
  return 1 - d / longest;
}
