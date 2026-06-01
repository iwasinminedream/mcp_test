/**
 * Maps a human-friendly asset "kind" to the set of Source 2 compiled (and source)
 * file extensions that belong to it. Extensions are stored WITHOUT a leading dot
 * and in lowercase, matching how they appear in the VPK directory tree.
 */
export const KIND_EXTENSIONS: Record<string, string[]> = {
  model: ['vmdl_c', 'vmdl'],
  mesh: ['vmesh_c', 'vmesh'],
  particle: ['vpcf_c', 'vpcf'],
  material: ['vmat_c', 'vmat'],
  texture: ['vtex_c', 'vtex'],
  sound: ['vsnd_c', 'vsnd'],
  soundevent: ['vsndevts_c', 'vsndevts'],
  soundstack: ['vsndstck_c', 'vsndstck'],
  animation: ['vanim_c', 'vanim', 'vagrp_c', 'vagrp', 'vseq_c', 'vseq'],
  physics: ['vphys_c', 'vphys'],
  surface: ['vsurf_c', 'vsurf'],
  world: ['vwrld_c', 'vwnod_c', 'vmap_c', 'vmap'],
  panorama: ['vxml_c', 'vcss_c', 'vjs_c', 'xml', 'css', 'js'],
  script: ['lua', 'vlua_c', 'txt', 'vts_c', 'cfg'],
  manifest: ['vrman_c', 'vrman'],
  postprocess: ['vpost_c', 'vpost'],
  smartprop: ['vsmart_c', 'vsmart'],
};

let extToKindCache: Map<string, string> | null = null;

function extToKind(): Map<string, string> {
  if (extToKindCache) return extToKindCache;
  const m = new Map<string, string>();
  for (const [kind, exts] of Object.entries(KIND_EXTENSIONS)) {
    for (const ext of exts) if (!m.has(ext)) m.set(ext, kind);
  }
  extToKindCache = m;
  return m;
}

/** Returns the kind name for a given extension, or "other" if unrecognized. */
export function kindForExt(ext: string): string {
  return extToKind().get(ext.toLowerCase()) ?? 'other';
}

/**
 * Returns the lowercase extension set for a kind, or null if the kind is unknown.
 * Accepts either a kind name (e.g. "model") or a raw extension (e.g. "vmdl_c").
 */
export function extensionsForKind(kind: string): Set<string> | null {
  const k = kind.toLowerCase();
  if (KIND_EXTENSIONS[k]) return new Set(KIND_EXTENSIONS[k]);
  // Allow passing a raw extension as a kind filter.
  if (extToKind().has(k)) return new Set([k]);
  return null;
}

export const VALID_KINDS = Object.keys(KIND_EXTENSIONS);
