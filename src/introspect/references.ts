import type { AssetIndex } from '../index/assetIndex.js';

export interface Reference {
  path: string;
  kind: string;
  exists: boolean;
}

/** Guesses a kind label from a reference path's extension. */
function kindOf(p: string): string {
  const ext = p.slice(p.lastIndexOf('.') + 1).replace(/_c$/, '');
  return ext || 'other';
}

/**
 * Annotates referenced asset paths with their kind and whether they exist in the
 * index. RERL paths usually omit the compiled `_c` suffix, so we check both forms.
 */
export function annotateReferences(
  index: AssetIndex,
  refs: string[],
  selfPath: string,
): { references: Reference[]; missing: string[] } {
  const selfBase = selfPath.replace(/_c$/i, '');
  const references = refs
    .filter((r) => r.replace(/_c$/i, '') !== selfBase)
    .map((r) => ({
      path: r,
      kind: kindOf(r),
      exists: index.has(r) || index.has(r + '_c'),
    }));
  return { references, missing: references.filter((r) => !r.exists).map((r) => r.path) };
}
