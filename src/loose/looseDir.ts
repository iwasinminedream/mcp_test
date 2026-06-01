import { openSync, readSync, closeSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { AssetEntry, AssetSource } from '../vpk/source.js';

/** A loose-file entry; carries its absolute on-disk path for reads. */
interface LooseEntry extends AssetEntry {
  abs: string;
}

/**
 * Indexes loose asset files in an addon folder (e.g.
 * `game/dota_addons/<name>/`). These compiled `_c` files live on disk rather than
 * inside a VPK, but share the same in-game namespace (paths relative to the addon
 * root), so they participate in search, introspection, and the dependency graph
 * exactly like VPK entries.
 */
export class LooseDir implements AssetSource {
  readonly source: string;
  readonly rootDir: string;
  private readonly map = new Map<string, LooseEntry>();

  constructor(rootDir: string, source: string) {
    this.rootDir = rootDir;
    this.source = source;
  }

  get id(): string {
    return `loose:${this.rootDir}:${this.map.size}`;
  }

  get count(): number {
    return this.map.size;
  }

  /** Recursively scans the root directory, building the entry map. */
  load(): void {
    this.map.clear();
    this.walk(this.rootDir, new Set<string>());
  }

  /**
   * Re-scans the folder and returns which asset paths changed since the last
   * load — used by the file watcher for incremental updates. `changed` = added or
   * content-changed (crc differs); `removed` = files that disappeared.
   */
  reload(): { changed: string[]; removed: string[] } {
    const prev = new Map<string, number>();
    for (const [rel, e] of this.map) prev.set(rel, e.crc);
    this.map.clear();
    this.walk(this.rootDir, new Set<string>());

    const changed: string[] = [];
    for (const [rel, e] of this.map) {
      const old = prev.get(rel);
      if (old === undefined || old !== e.crc) changed.push(rel);
      prev.delete(rel);
    }
    const removed = [...prev.keys()]; // whatever was not seen this pass
    return { changed, removed };
  }

  private walk(dir: string, seen: Set<string>): void {
    // Guard against symlink cycles: the root and its children may be symlinks
    // (addon projects symlink `game` into the Steam install), so track visited
    // real directory paths.
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);

    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        this.walk(abs, seen);
        continue;
      }
      if (!st.isFile()) continue;

      const rel = relative(this.rootDir, abs).split(sep).join('/');
      const slash = rel.lastIndexOf('/');
      const fileName = slash === -1 ? rel : rel.slice(slash + 1);
      const dot = fileName.lastIndexOf('.');
      const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
      const baseName = dot > 0 ? fileName.slice(0, dot) : fileName;
      // Change token without reading the file: mtime ^ size (changes on recompile).
      const crc = ((Math.floor(st.mtimeMs) ^ st.size) >>> 0);

      this.map.set(rel, {
        path: rel,
        ext,
        dir: slash === -1 ? '' : rel.slice(0, slash),
        name: baseName,
        crc,
        size: st.size,
        archiveIndex: 0,
        entryOffset: 0,
        preloadBytes: 0,
        entryLength: st.size,
        abs,
      });
    }
  }

  listEntries(): IterableIterator<LooseEntry> {
    return this.map.values();
  }

  readFull(entry: AssetEntry): Buffer {
    return readFileSync((entry as LooseEntry).abs);
  }

  readRange(entry: AssetEntry, start: number, len: number, fdCache?: Map<string, number>): Buffer {
    const abs = (entry as LooseEntry).abs;
    let fd = fdCache?.get(abs);
    let ownFd = false;
    if (fd === undefined) {
      fd = openSync(abs, 'r');
      if (fdCache) fdCache.set(abs, fd);
      else ownFd = true;
    }
    try {
      const want = Math.max(0, Math.min(len, entry.size - start));
      if (want <= 0) return Buffer.alloc(0);
      const data = Buffer.alloc(want);
      const n = readSync(fd, data, 0, want, start);
      return n === want ? data : data.subarray(0, n);
    } finally {
      if (ownFd) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }
}
