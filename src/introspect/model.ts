import type { AssetIndex } from '../index/assetIndex.js';
import {
  extractStrings,
  findAttachments,
  findAttachmentsInText,
  findAssetRefs,
  parseRerlNames,
} from '../strings.js';
import { dumpAllBlocks, dumpBlock, cliAvailable } from '../cli/decompiler.js';
import { annotateReferences, type Reference } from './references.js';
import { TtlCache } from '../cache.js';

export interface ModelInfo {
  path: string;
  source: string;
  size: number;
  /** Attachment-point names (attach_*) you can bind particles to. */
  attachments: string[];
  attachmentsVia: 'cli' | 'strings-fallback';
  /** Referenced assets (materials, sub-models, particles), split by existence. */
  references: Reference[];
  missingReferences: string[];
  referencesVia: 'rerl' | 'strings-fallback';
  note: string;
  error?: string;
  suggestions?: { path: string; score: number }[];
}

const cache = new TtlCache<ModelInfo>();
const MODEL_EXTS = new Set(['vmdl_c', 'vmdl', 'vmesh_c', 'vmesh']);

/**
 * Inspects a Source 2 model (.vmdl_c): its attachment-point names and referenced
 * assets.
 *
 * Attachments: the model DATA block is LZ4-compressed binary KV3, so a raw
 * strings scan finds nothing and `-b DATA` prints nothing — but `-a` (all blocks)
 * decompresses it, and the attachment names appear there as `attach_*` tokens
 * (verified on axe.vmdl_c → attach_attack1, attach_hitloc, attach_origin, ...).
 * Without the CLI we fall back to a raw strings scan (usually empty for heroes).
 *
 * References come from the model's RERL block when the CLI is available, else a
 * strings scan. Limitation: attachment NAMES only — bone parent and offset/
 * rotation live in the binary DATA struct and are not parsed in M2.
 */
export async function modelInfo(index: AssetIndex, path: string): Promise<ModelInfo> {
  const read = index.read(path);
  if (!read) {
    const suggestions = index
      .resolve(path, { kind: 'model', limit: 5 })
      .results.map((r) => ({ path: r.path, score: r.score }));
    return {
      path, source: '', size: 0, attachments: [], attachmentsVia: 'strings-fallback',
      references: [], missingReferences: [], referencesVia: 'strings-fallback',
      note: 'Asset not found.', error: `No asset at "${path}".`, suggestions,
    };
  }

  const cached = cache.get(String(read.crc));
  if (cached) return cached;

  if (!MODEL_EXTS.has(read.ext)) {
    return {
      path: read.path, source: read.source, size: read.size, attachments: [],
      attachmentsVia: 'strings-fallback', references: [], missingReferences: [],
      referencesVia: 'strings-fallback',
      note: `Not a model (.${read.ext}). Use particle_info / material_info / decompile instead.`,
      error: 'Wrong asset kind for model_info.',
    };
  }

  let attachments: string[];
  let attachmentsVia: 'cli' | 'strings-fallback';
  let refs: string[];
  let refsVia: 'rerl' | 'strings-fallback';

  if (cliAvailable()) {
    // One `-a` dump gives attachments (decompressed DATA); RERL gives clean refs.
    const [all, rerl] = await Promise.all([
      dumpAllBlocks(read.bytes, read.path).catch(() => ''),
      dumpBlock(read.bytes, read.path, 'RERL').catch(() => ''),
    ]);
    attachments = findAttachmentsInText(all);
    attachmentsVia = 'cli';
    if (attachments.length === 0) {
      // Fallback in case the dump format changes.
      const viaStrings = findAttachments(extractStrings(read.bytes));
      if (viaStrings.length > 0) {
        attachments = viaStrings;
        attachmentsVia = 'strings-fallback';
      }
    }
    refs = parseRerlNames(rerl);
    refsVia = 'rerl';
    if (refs.length === 0) {
      refs = findAssetRefs(extractStrings(read.bytes));
      refsVia = 'strings-fallback';
    }
  } else {
    attachments = findAttachments(extractStrings(read.bytes));
    attachmentsVia = 'strings-fallback';
    refs = findAssetRefs(extractStrings(read.bytes));
    refsVia = 'strings-fallback';
  }

  const { references, missing } = annotateReferences(index, refs, read.path);
  const info: ModelInfo = {
    path: read.path,
    source: read.source,
    size: read.size,
    attachments,
    attachmentsVia,
    references,
    missingReferences: missing,
    referencesVia: refsVia,
    note:
      attachmentsVia === 'cli'
        ? 'Attachments from the decompressed DATA block (-a); references from RERL. Bone/offset not parsed in M2.'
        : 'CLI unavailable — attachment names from a raw strings scan may be incomplete for hero models.',
  };
  cache.set(String(read.crc), info);
  return info;
}
