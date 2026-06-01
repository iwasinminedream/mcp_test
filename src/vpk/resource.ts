import type { AssetEntry, AssetSource } from './source.js';

/**
 * Minimal Source 2 compiled-resource header parser, just enough to locate the
 * RERL (external reference list) block and read its referenced asset paths
 * WITHOUT decompiling. Verified to match Source2Viewer-CLI's RERL output exactly
 * on models, particles, and materials.
 *
 * Header layout (little-endian):
 *   u32 fileSize, u16 headerVersion, u16 resourceVersion,
 *   u32 blockOffset (from offset +8), u32 blockCount;
 *   then blockCount × { char[4] name, u32 offset (from this field), u32 size }.
 *
 * RERL block body:
 *   u32 entriesRel (to the entry array, from this field), u32 count;
 *   each entry: u64 id, u32 nameRel (to a NUL-terminated path, from this field).
 */

/** How many leading bytes to read to cover the header + block table. */
export const HEADER_CHUNK = 16384;

export interface BlockRef {
  name: string;
  /** Absolute offset of the block within the logical file. */
  abs: number;
  size: number;
}

/** Parses the block table from a buffer that begins at the file start. */
export function parseBlockTable(head: Buffer): BlockRef[] {
  if (head.length < 16) return [];
  const blockOffset = head.readUInt32LE(8);
  const blockCount = head.readUInt32LE(12);
  if (blockCount === 0 || blockCount > 64) return [];

  const tableStart = 8 + blockOffset;
  if (tableStart + blockCount * 12 > head.length) return []; // header bigger than our chunk

  const blocks: BlockRef[] = [];
  let p = tableStart;
  for (let i = 0; i < blockCount; i++) {
    const name = head.toString('latin1', p, p + 4);
    const off = head.readUInt32LE(p + 4);
    const size = head.readUInt32LE(p + 8);
    blocks.push({ name, abs: p + 4 + off, size });
    p += 12;
  }
  return blocks;
}

/** Parses referenced resource paths from a standalone RERL block buffer. */
export function parseRerlBlock(body: Buffer): string[] {
  if (body.length < 8) return [];
  const entriesRel = body.readUInt32LE(0);
  const count = body.readUInt32LE(4);
  if (count === 0 || count > 100000) return [];

  const entriesStart = entriesRel; // body starts at the RERL block, so q = 0
  const refs: string[] = [];
  for (let i = 0; i < count; i++) {
    const e = entriesStart + i * 16;
    if (e + 12 > body.length) break;
    const nameRel = body.readUInt32LE(e + 8); // skip u64 id
    const nameAbs = e + 8 + nameRel;
    if (nameAbs < 0 || nameAbs >= body.length) continue;
    const end = body.indexOf(0, nameAbs);
    const path = body.toString('latin1', nameAbs, end === -1 ? body.length : end);
    if (path) refs.push(path.replace(/\\/g, '/'));
  }
  return refs;
}

/**
 * Reads an entry's RERL references via two small positioned reads (the header
 * chunk + the RERL block), reusing a shared fd-cache. Works on any AssetSource
 * (VPK archive or loose addon folder). Returns [] if the resource has no RERL
 * block or the header doesn't fit the chunk.
 */
export function readRerlRefs(
  source: AssetSource,
  entry: AssetEntry,
  fdCache?: Map<string, number>,
): string[] {
  const head = source.readRange(entry, 0, HEADER_CHUNK, fdCache);
  const blocks = parseBlockTable(head);
  const rerl = blocks.find((b) => b.name === 'RERL');
  if (!rerl || rerl.size === 0) return [];
  const body = source.readRange(entry, rerl.abs, rerl.size, fdCache);
  return parseRerlBlock(body);
}
