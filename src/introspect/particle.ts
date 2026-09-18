import type { AssetIndex } from '../index/assetIndex.js';
import { decompileToText, dumpBlock, cliAvailable } from '../cli/decompiler.js';
import { parseRerlNames, extractStrings, findAssetRefs } from '../strings.js';
import { annotateReferences, type Reference } from './references.js';
import { TtlCache } from '../cache.js';

/** One control-point binding inside a particle's preview/config (m_drivers entry). */
export interface ControlPointDriver {
  /** Control-point index this driver configures (m_iControlPoint, defaults to 0). */
  controlPoint: number;
  /** Attach type, e.g. "PATTACH_POINT_FOLLOW", "PATTACH_WORLDORIGIN". */
  attachType: string;
  /** Entity the control point follows, e.g. "parent" / "self". */
  entityName?: string;
  /** Attachment name on the entity, e.g. "attach_attack1" (point-follow types only). */
  attachmentName?: string;
}

/** A control-point configuration (m_controlPointConfigurations entry), usually "preview". */
export interface ControlPointConfiguration {
  name: string;
  drivers: ControlPointDriver[];
}

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
  /**
   * Control-point indices used by this particle AND all descendant child
   * particles (recursive union; best-effort from the KV3). Raw index union — no
   * parent/child control-point remapping is resolved.
   */
  controlPoints: number[];
  /**
   * Control-point configurations from m_controlPointConfigurations (usually a
   * single "preview" config): how each control point binds to an attachment and
   * attach type. This particle's OWN configs only (not aggregated over children).
   */
  controlPointConfigurations: ControlPointConfiguration[];
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
  return particleInfoRec(index, path, new Set<string>());
}

/**
 * Inner worker carrying the cycle-guard `visited` set (crc-keyed). A particle's
 * `controlPoints` is the recursive union of its own control points and those of
 * every descendant child particle — each child's returned value is already its
 * own subtree's aggregate, so unioning the immediate children yields the full
 * transitive union. `visited` prevents infinite recursion on A->B->A.
 */
async function particleInfoRec(
  index: AssetIndex,
  path: string,
  visited: Set<string>,
): Promise<ParticleInfo> {
  const read = index.read(path);
  if (!read) {
    const suggestions = index
      .resolve(path, { kind: 'particle', limit: 5 })
      .results.map((r) => ({ path: r.path, score: r.score }));
    return blank(path, 'Asset not found.', `No asset at "${path}".`, suggestions);
  }

  const crcKey = String(read.crc);

  const cached = cache.get(crcKey);
  if (cached) return cached;

  // Cycle guard: this particle is already being computed up the stack. Contribute
  // nothing new (its aggregate isn't ready yet); the union just omits it here.
  if (visited.has(crcKey)) {
    return blank(read.path, 'Cycle guard: already visiting this particle.', 'cycle');
  }

  if (!PARTICLE_EXTS.has(read.ext)) {
    return blank(
      read.path,
      `Not a particle (.${read.ext}). Use model_info / material_info / decompile instead.`,
      'Wrong asset kind for particle_info.',
    );
  }

  visited.add(crcKey);

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
      const controlPointConfigurations = parseControlPointConfigs(text);
      const childParticles = refs.filter((r) => /\.vpcf(_c)?$/i.test(r));

      // Recursively fold each child particle's (already-aggregated) control points
      // into this particle's set, so a parent that only includes children still
      // reports the control points those children use.
      for (const childRef of childParticles) {
        const childPath = canonicalChild(index, childRef);
        if (!childPath) continue; // missing/unindexed — also surfaced in missingReferences
        const childInfo = await particleInfoRec(index, childPath, visited);
        for (const cp of childInfo.controlPoints) cpSet.add(cp);
      }

      let note = 'Decompiled with Source2Viewer-CLI; references from the RERL block.';
      if (childParticles.length > 0) {
        note += ' Control points are the recursive union over child particles.';
      }

      info = {
        path: read.path,
        source: read.source,
        size: read.size,
        decompiledVia: 'cli',
        maxParticles: maxM ? Number(maxM[1]) : null,
        childParticles,
        functionClasses,
        controlPoints: [...cpSet].sort((a, b) => a - b),
        controlPointConfigurations,
        references,
        missingReferences: missing,
        note,
      };
    } catch (err) {
      info = stringsFallback(read, index);
      info.note += ` (CLI failed: ${(err as Error).message})`;
    }
  } else {
    info = stringsFallback(read, index);
  }

  cache.set(crcKey, info);
  return info;
}

/** Resolves a RERL child ref to its indexed path form, trying the `_c` suffix. */
function canonicalChild(index: AssetIndex, ref: string): string | null {
  if (index.has(ref)) return ref;
  if (index.has(ref + '_c')) return ref + '_c';
  return null;
}

/**
 * Extracts m_controlPointConfigurations from the decompiled KV3 text: each config
 * (usually "preview") and its m_drivers, mapping control points to attachment
 * names/types. Best-effort bracket-balanced scan over the text (not a full KV3
 * parser) — matching the rest of this module's regex-based extraction.
 */
function parseControlPointConfigs(text: string): ControlPointConfiguration[] {
  const body = balancedBlock(text, 'm_controlPointConfigurations', '[');
  if (body === null) return [];
  const configs: ControlPointConfiguration[] = [];
  for (const cfg of splitTopLevelObjects(body)) {
    const nameM = /m_name\s*=\s*"([^"]*)"/.exec(cfg);
    const driversBody = balancedBlock(cfg, 'm_drivers', '[');
    const drivers: ControlPointDriver[] = [];
    if (driversBody !== null) {
      for (const d of splitTopLevelObjects(driversBody)) {
        const at = /m_iAttachType\s*=\s*"([^"]*)"/.exec(d);
        if (!at) continue; // a driver without an attach type carries no binding
        const cp = /m_iControlPoint\s*=\s*(\d+)/.exec(d);
        const en = /m_entityName\s*=\s*"([^"]*)"/.exec(d);
        const an = /m_attachmentName\s*=\s*"([^"]*)"/.exec(d);
        drivers.push({
          controlPoint: cp ? Number(cp[1]) : 0, // m_iControlPoint absent ⇒ CP 0
          attachType: at[1]!,
          ...(en ? { entityName: en[1]! } : {}),
          ...(an ? { attachmentName: an[1]! } : {}),
        });
      }
    }
    configs.push({ name: nameM ? nameM[1]! : '', drivers });
  }
  return configs;
}

/** Returns the text between the matching brackets of `key = <open>…<close>`, or null. */
function balancedBlock(text: string, key: string, open: '[' | '{'): string | null {
  const close = open === '[' ? ']' : '}';
  const keyIdx = text.indexOf(key);
  if (keyIdx < 0) return null;
  const start = text.indexOf(open, keyIdx);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(start + 1, i);
  }
  return null;
}

/** Splits a KV3 array body into its top-level `{…}` object bodies (bracket-aware). */
function splitTopLevelObjects(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let objStart = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body.charAt(i);
    if (ch === '{' || ch === '[') {
      if (ch === '{' && depth === 0) objStart = i + 1;
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (ch === '}' && depth === 0 && objStart >= 0) {
        out.push(body.slice(objStart, i));
        objStart = -1;
      }
    }
  }
  return out;
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
    controlPointConfigurations: [],
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
    childParticles: [], functionClasses: [], controlPoints: [], controlPointConfigurations: [],
    references: [], missingReferences: [], note, error, suggestions,
  };
}
