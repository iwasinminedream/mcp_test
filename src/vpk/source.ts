import { closeSync } from 'node:fs';

/**
 * A single asset entry, independent of where it physically lives (inside a VPK
 * archive or as a loose file on disk in an addon folder). Paths use forward
 * slashes and are relative to the content root, matching the in-game namespace.
 */
export interface AssetEntry {
  /** Full asset path, e.g. "models/heroes/axe/axe.vmdl_c". */
  path: string;
  /** Extension without dot, lowercase ("" if none). */
  ext: string;
  /** Directory portion ("" for the root). */
  dir: string;
  /** Filename without extension. */
  name: string;
  /** Change token: a real CRC32 for VPK entries, or mtime^size for loose files. */
  crc: number;
  /** Total content size in bytes. */
  size: number;
  // Sort/locality hints (VPK-specific; 0 for loose files).
  archiveIndex: number;
  entryOffset: number;
  preloadBytes: number;
  entryLength: number;
}

/**
 * A provider of asset entries with on-demand byte access. Implemented by
 * {@link VpkArchive} (VPK packages) and {@link LooseDir} (addon folders), so the
 * index, introspection, and dependency graph treat both uniformly.
 */
export interface AssetSource {
  /** Short label shown in results, e.g. "dota", "core", "addon:dota_test_2". */
  readonly source: string;
  /** Stable id for cache fingerprinting (e.g. the file/dir path + entry count). */
  readonly id: string;
  /** Iterates the source's entries. */
  listEntries(): IterableIterator<AssetEntry>;
  /** Reads an entry's full bytes. */
  readFull(entry: AssetEntry): Buffer;
  /**
   * Reads a byte window `[start, start+len)` of an entry. Pass a shared
   * `fdCache` (keyed by underlying file path) to reuse descriptors across many
   * reads; close it with {@link closeFdCache} when done.
   */
  readRange(entry: AssetEntry, start: number, len: number, fdCache?: Map<string, number>): Buffer;
}

/** Closes all file descriptors held in a shared fd-cache. */
export function closeFdCache(fdCache: Map<string, number>): void {
  for (const fd of fdCache.values()) {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }
  fdCache.clear();
}
