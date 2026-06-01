import type { AssetIndex } from '../index/assetIndex.js';
import { decompileToText, dumpBlock, cliAvailable } from '../cli/decompiler.js';
import { parseRerlNames, extractStrings, findAssetRefs } from '../strings.js';
import { annotateReferences, type Reference } from './references.js';
import { TtlCache } from '../cache.js';

export interface ParticleInfo {
  path: string;
  source: string;
  size: number;
  decompiledVia: 'cli' | 'strings-fallback';
  maxParticles: number | null;
  /** Child particle systems referenced via m_Children/m_ChildRef. */
  childParticles: string[];
  /** Function classes present (C_OP_*, C_INIT_*, C_EMIT_*, renderer classes). */
  functionClasses: string[];
  /** Control-point indices the particle reads (best-effort from the KV3). */
  controlPoints: number[];
  /** All referenced assets, split by whether they exist in the index. */
  references: Reference[];
  missingReferences: string[];
  note: string;
  error?: string;
  suggestions?: { path: string; score: number }[];
}

const cache = new TtlCache<ParticleInfo>();
const PARTICLE_EXTS = new Set(['vpcf_c', 'vpcf']);

/**
 * Decompiles a .vpcf_c via Source2Viewer-CLI and extracts its structure (function
 * classes, max particles, control points) plus its cross-references (materials,
 * textures, child particles) from the RERL block — so referenced asset paths are
 * read, not guessed. Falls back to a raw strings scan if the CLI is unavailable.
 */
export async function particleInfo(index: AssetIndex, path: string): Promise<ParticleInfo> {
  const read = index.read(path);
  if (!read) {
    const suggestions = index
      .resolve(path, { kind: 'particle', limit: 5 })
      .results.map((r) => ({ path: r.path, score: r.score }));
    return blank(path, 'Asset not found.', `No asset at "${path}".`, suggestions);
  }

  const cached = cache.get(String(read.crc));
  if (cached) return cached;

  if (!PARTICLE_EXTS.has(read.ext)) {
    return blank(
      read.path,
      `Not a particle (.${read.ext}). Use model_info / material_info / decompile instead.`,
      'Wrong asset kind for particle_info.',
    );
  }

  let info: ParticleInfo;
  if (cliAvailable()) {
    try {
      const [text, rerl] = await Promise.all([
        decompileToText(read.bytes, read.path),
        dumpBlock(read.bytes, read.path, 'RERL'),
      ]);
      const refs = parseRerlNames(rerl);
      const { references, missing } = annotateReferences(index, refs, read.path);

      const functionClasses = [
        ...new Set([...text.matchAll(/_class\s*=\s*"([^"]+)"/g)].map((m) => m[1]!)),
      ].sort();
      const cpSet = new Set<number>();
      for (const m of text.matchAll(/m_nControlPoint(?:Number)?\d*\s*=\s*(\d+)/g)) {
        cpSet.add(Number(m[1]));
      }
      const maxM = text.match(/m_nMaxParticles\s*=\s*(\d+)/);

      info = {
        path: read.path,
        source: read.source,
        size: read.size,
        decompiledVia: 'cli',
        maxParticles: maxM ? Number(maxM[1]) : null,
        childParticles: refs.filter((r) => /\.vpcf(_c)?$/i.test(r)),
        functionClasses,
        controlPoints: [...cpSet].sort((a, b) => a - b),
        references,
        missingReferences: missing,
        note: 'Decompiled with Source2Viewer-CLI; references from the RERL block.',
      };
    } catch (err) {
      info = stringsFallback(read, index);
      info.note += ` (CLI failed: ${(err as Error).message})`;
    }
  } else {
    info = stringsFallback(read, index);
  }

  cache.set(String(read.crc), info);
  return info;
}

function stringsFallback(
  read: NonNullable<ReturnType<AssetIndex['read']>>,
  index: AssetIndex,
): ParticleInfo {
  const refs = findAssetRefs(extractStrings(read.bytes));
  const { references, missing } = annotateReferences(index, refs, read.path);
  return {
    path: read.path,
    source: read.source,
    size: read.size,
    decompiledVia: 'strings-fallback',
    maxParticles: null,
    childParticles: refs.filter((r) => /\.vpcf(_c)?$/i.test(r)),
    functionClasses: [],
    controlPoints: [],
    references,
    missingReferences: missing,
    note: 'CLI unavailable — references recovered via raw strings scan (no structure).',
  };
}

function blank(
  path: string,
  note: string,
  error: string,
  suggestions?: { path: string; score: number }[],
): ParticleInfo {
  return {
    path, source: '', size: 0, decompiledVia: 'strings-fallback', maxParticles: null,
    childParticles: [], functionClasses: [], controlPoints: [], references: [],
    missingReferences: [], note, error, suggestions,
  };
}
