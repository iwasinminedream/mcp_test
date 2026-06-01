import { openSync, readSync, closeSync, readFileSync } from 'node:fs';
import type { AssetEntry, AssetSource } from './source.js';

/** A single file entry parsed from a VPK directory tree (an {@link AssetEntry}). */
export interface VpkEntry extends AssetEntry {
  /** Offset of the inline preload bytes within the _dir.vpk buffer. */
  preloadOffset: number;
}

const VPK_SIGNATURE = 0x55aa1234;
/** ArchiveIndex sentinel: data is embedded in the _dir.vpk after the tree. */
const EMBEDDED_ARCHIVE = 0x7fff;
/** Per-entry terminator value. */
const ENTRY_TERMINATOR = 0xffff;

/**
 * Reads a Valve VPK v1/v2 directory file (e.g. pak01_dir.vpk) used by Source 2 /
 * Dota 2. Parses only the directory tree up front (cheap); file bytes are read
 * on demand from the numbered split archives or the embedded data section.
 *
 * Format reference (verified against the Valve wiki + fwdcp/node-vpk + VRF):
 *   header: u32 signature(0x55AA1234), u32 version, u32 treeSize [, v2: +4×u32]
 *   tree:   nested NUL-terminated strings  extension -> directory -> filename,
 *           each level ending on an empty string; " " means empty/root.
 *   entry:  u32 crc, u16 preloadBytes, u16 archiveIndex, u32 entryOffset,
 *           u32 entryLength, u16 terminator(0xFFFF), then preloadBytes inline.
 */
export class VpkArchive implements AssetSource {
  readonly dirPath: string;
  readonly source: string;
  readonly entries = new Map<string, VpkEntry>();

  private headerSize = 0;
  private treeSize = 0;
  private dirBuf: Buffer = Buffer.alloc(0);

  constructor(dirPath: string, source: string) {
    this.dirPath = dirPath;
    this.source = source;
  }

  load(): void {
    const buf = readFileSync(this.dirPath);
    this.dirBuf = buf;

    let o = 0;
    const signature = buf.readUInt32LE(o);
    o += 4;
    if (signature !== VPK_SIGNATURE) {
      throw new Error(
        `Bad VPK signature 0x${signature.toString(16)} in ${this.dirPath}`,
      );
    }
    const version = buf.readUInt32LE(o);
    o += 4;
    this.treeSize = buf.readUInt32LE(o);
    o += 4;

    if (version === 1) {
      this.headerSize = 12;
    } else if (version === 2) {
      o += 16; // FileDataSectionSize, ArchiveMD5SectionSize, OtherMD5SectionSize, SignatureSectionSize
      this.headerSize = 28;
    } else {
      throw new Error(`Unsupported VPK version ${version} in ${this.dirPath}`);
    }

    o = this.headerSize;
    const readCStr = (): string => {
      const end = buf.indexOf(0, o);
      const s = buf.toString('latin1', o, end);
      o = end + 1;
      return s;
    };

    for (let ext = readCStr(); ext !== ''; ext = readCStr()) {
      for (let dir = readCStr(); dir !== ''; dir = readCStr()) {
        for (let name = readCStr(); name !== ''; name = readCStr()) {
          const crc = buf.readUInt32LE(o);
          o += 4;
          const preloadBytes = buf.readUInt16LE(o);
          o += 2;
          const archiveIndex = buf.readUInt16LE(o);
          o += 2;
          const entryOffset = buf.readUInt32LE(o);
          o += 4;
          const entryLength = buf.readUInt32LE(o);
          o += 4;
          const terminator = buf.readUInt16LE(o);
          o += 2;
          if (terminator !== ENTRY_TERMINATOR) {
            throw new Error(
              `Bad VPK entry terminator 0x${terminator.toString(16)} at ${name} in ${this.dirPath}`,
            );
          }
          const preloadOffset = o;
          o += preloadBytes;

          const d = dir === ' ' ? '' : dir;
          const e = ext === ' ' ? '' : ext;
          const path = (d ? d + '/' : '') + name + (e ? '.' + e : '');
          this.entries.set(path, {
            path,
            ext: e,
            dir: d,
            name,
            crc,
            preloadBytes,
            archiveIndex,
            entryOffset,
            entryLength,
            preloadOffset,
            size: preloadBytes + entryLength,
          });
        }
      }
    }
  }

  /** Stable id for cache fingerprinting. */
  get id(): string {
    return `vpk:${this.dirPath}:${this.entries.size}`;
  }

  /** Iterates this archive's entries (AssetSource). */
  listEntries(): IterableIterator<VpkEntry> {
    return this.entries.values();
  }

  /** Reads an entry's full bytes (AssetSource). */
  readFull(entry: VpkEntry): Buffer {
    return this.readFile(entry);
  }

  /** Reads the full raw bytes of an entry (preload ++ archive data). */
  readFile(entry: VpkEntry): Buffer {
    const preload =
      entry.preloadBytes > 0
        ? this.dirBuf.subarray(
            entry.preloadOffset,
            entry.preloadOffset + entry.preloadBytes,
          )
        : Buffer.alloc(0);

    if (entry.entryLength === 0) return Buffer.from(preload);

    if (entry.archiveIndex === EMBEDDED_ARCHIVE) {
      const abs = this.headerSize + this.treeSize + entry.entryOffset;
      const data = this.dirBuf.subarray(abs, abs + entry.entryLength);
      return Buffer.concat([preload, data]);
    }

    const fd = openSync(this.archivePathFor(entry), 'r');
    try {
      const data = Buffer.alloc(entry.entryLength);
      readSync(fd, data, 0, entry.entryLength, entry.entryOffset);
      return Buffer.concat([preload, data]);
    } finally {
      closeSync(fd);
    }
  }

  /** Resolves the on-disk archive file that holds an entry's data. */
  archivePathFor(entry: VpkEntry): string {
    if (entry.archiveIndex === EMBEDDED_ARCHIVE) return this.dirPath;
    const num = String(entry.archiveIndex).padStart(3, '0');
    return this.dirPath.replace(/_dir\.vpk$/i, `_${num}.vpk`);
  }

  /**
   * Reads a byte window `[start, start+len)` of an entry's logical content
   * (preload ++ archive data), without loading the whole file. Used by the
   * dependency-graph builder to read just the header chunk and the RERL block of
   * each file (a model can be 600 KB but we only touch ~16 KB). Pass a shared
   * `fdCache` (keyed by archive path) to keep each numbered archive open across
   * many reads; close it with `closeFdCache` when done.
   */
  readRange(entry: VpkEntry, start: number, len: number, fdCache?: Map<string, number>): Buffer {
    const end = start + len;
    const parts: Buffer[] = [];

    // Preload region: [0, preloadBytes)
    if (entry.preloadBytes > 0 && start < entry.preloadBytes) {
      const pStart = entry.preloadOffset + start;
      const pEnd = entry.preloadOffset + Math.min(entry.preloadBytes, end);
      parts.push(this.dirBuf.subarray(pStart, pEnd));
    }

    // Archive region: [preloadBytes, preloadBytes + entryLength)
    if (entry.entryLength > 0 && end > entry.preloadBytes) {
      const aFrom = Math.max(start, entry.preloadBytes) - entry.preloadBytes;
      const aTo = Math.min(end, entry.preloadBytes + entry.entryLength) - entry.preloadBytes;
      const want = aTo - aFrom;
      if (want > 0) {
        if (entry.archiveIndex === EMBEDDED_ARCHIVE) {
          const base = this.headerSize + this.treeSize + entry.entryOffset + aFrom;
          parts.push(this.dirBuf.subarray(base, base + want));
        } else {
          const archivePath = this.archivePathFor(entry);
          let fd = fdCache?.get(archivePath);
          let ownFd = false;
          if (fd === undefined) {
            fd = openSync(archivePath, 'r');
            if (fdCache) fdCache.set(archivePath, fd);
            else ownFd = true;
          }
          try {
            const data = Buffer.alloc(want);
            const n = readSync(fd, data, 0, want, entry.entryOffset + aFrom);
            parts.push(n === want ? data : data.subarray(0, n));
          } finally {
            if (ownFd) closeSync(fd);
          }
        }
      }
    }

    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }
}
