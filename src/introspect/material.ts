import type { AssetIndex } from '../index/assetIndex.js';
import { decompileToText, dumpBlock, cliAvailable } from '../cli/decompiler.js';
import { parseRerlNames, extractStrings, findAssetRefs } from '../strings.js';
import { annotateReferences, type Reference } from './references.js';
import { TtlCache } from '../cache.js';

export interface MaterialInfo {
  path: string;
  source: string;
  size: number;
  decompiledVia: 'cli' | 'strings-fallback';
  shader: string | null;
  /** Texture/asset references, split by whether they exist in the index. */
  references: Reference[];
  missingReferences: string[];
  note: string;
  error?: string;
  suggestions?: { path: string; score: number }[];
}

const cache = new TtlCache<MaterialInfo>();
const MATERIAL_EXTS = new Set(['vmat_c', 'vmat']);

/** Decompiles a .vmat_c and extracts its shader name and texture references. */
export async function materialInfo(index: AssetIndex, path: string): Promise<MaterialInfo> {
  const read = index.read(path);
  if (!read) {
    const suggestions = index
      .resolve(path, { kind: 'material', limit: 5 })
      .results.map((r) => ({ path: r.path, score: r.score }));
    return {
      path, source: '', size: 0, decompiledVia: 'strings-fallback', shader: null,
      references: [], missingReferences: [], note: 'Asset not found.',
      error: `No asset at "${path}".`, suggestions,
    };
  }

  const cached = cache.get(String(read.crc));
  if (cached) return cached;

  if (!MATERIAL_EXTS.has(read.ext)) {
    return {
      path: read.path, source: read.source, size: read.size,
      decompiledVia: 'strings-fallback', shader: null, references: [], missingReferences: [],
      note: `Not a material (.${read.ext}).`, error: 'Wrong asset kind for material_info.',
    };
  }

  let shader: string | null = null;
  let refs: string[];
  let via: 'cli' | 'strings-fallback';
  let note: string;

  if (cliAvailable()) {
    try {
      const [text, rerl] = await Promise.all([
        decompileToText(read.bytes, read.path),
        dumpBlock(read.bytes, read.path, 'RERL'),
      ]);
      const sm =
        text.match(/m_shaderName\s*=\s*"([^"]+)"/) ?? text.match(/shader\s*=\s*"([^"]+)"/);
      shader = sm ? sm[1]! : null;
      refs = parseRerlNames(rerl);
      via = 'cli';
      note = 'Decompiled with Source2Viewer-CLI; references from the RERL block.';
    } catch (err) {
      refs = findAssetRefs(extractStrings(read.bytes));
      via = 'strings-fallback';
      note = `CLI failed (${(err as Error).message}); used strings scan.`;
    }
  } else {
    refs = findAssetRefs(extractStrings(read.bytes));
    via = 'strings-fallback';
    note = 'CLI unavailable — references recovered via raw strings scan.';
  }

  const { references, missing } = annotateReferences(index, refs, read.path);
  const info: MaterialInfo = {
    path: read.path,
    source: read.source,
    size: read.size,
    decompiledVia: via,
    shader,
    references,
    missingReferences: missing,
    note,
  };
  cache.set(String(read.crc), info);
  return info;
}
