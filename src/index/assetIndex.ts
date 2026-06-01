import type { AssetEntry, AssetSource } from '../vpk/source.js';
import { closeFdCache } from '../vpk/source.js';
import { readRerlRefs } from '../vpk/resource.js';
import { kindForExt, extensionsForKind } from '../kinds.js';
import { boundedLevenshtein } from '../fuzzy.js';

interface IndexedEntry {
  e: AssetEntry;
  provider: AssetSource;
  source: string;
  lowerPath: string;
  lowerName: string;
  kind: string;
}

export interface AssetResult {
  path: string;
  kind: string;
  size: number;
  source: string;
}

export interface FindResult {
  query: string;
  kind: string | null;
  total: number;
  count: number;
  offset: number;
  results: AssetResult[];
}

export interface ResolveResult {
  query: string;
  kind: string | null;
  results: (AssetResult & { score: number })[];
}

export interface ListDirResult {
  prefix: string;
  dirCount: number;
  fileCount: number;
  dirs: { name: string; count: number }[];
  files: AssetResult[];
}

export interface StatResult {
  path: string;
  exists: boolean;
  kind?: string;
  size?: number;
  source?: string;
  archiveIndex?: number;
  entryLength?: number;
  preloadBytes?: number;
  crc32?: number;
  suggestions?: (AssetResult & { score: number })[];
}

export interface ReadResult {
  bytes: Buffer;
  path: string;
  kind: string;
  ext: string;
  source: string;
  crc: number;
  size: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob: string): RegExp {
  const body = glob.split('*').map(escapeRegExp).join('.*');
  return new RegExp('^' + body + '$');
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

/**
 * Aggregates one or more asset sources (VPK packages and addon folders) into a
 * single searchable namespace. Sources added earlier win on a path collision
 * (the active addon is added before the base VPKs so its assets override).
 */
export class AssetIndex {
  private sources: AssetSource[] = [];
  private byPath = new Map<string, IndexedEntry>();
  private all: IndexedEntry[] = [];

  get size(): number {
    return this.all.length;
  }

  /** Registers an asset source. */
  addSource(s: AssetSource): void {
    this.sources.push(s);
  }

  /** Builds the aggregated lookup structures. Earlier sources win on collision. */
  finalize(): void {
    this.byPath.clear();
    this.all = [];
    for (const s of this.sources) {
      for (const e of s.listEntries()) {
        // The engine treats asset paths case-insensitively; key on lowercase.
        const lowerPath = e.path.toLowerCase();
        if (this.byPath.has(lowerPath)) continue;
        const ie: IndexedEntry = {
          e,
          provider: s,
          source: s.source,
          lowerPath,
          lowerName: e.name.toLowerCase(),
          kind: kindForExt(e.ext),
        };
        this.byPath.set(lowerPath, ie);
        this.all.push(ie);
      }
    }
  }

  private pool(kind: string | undefined): {
    entries: IndexedEntry[];
    exts: Set<string> | null;
    error?: string;
  } {
    if (!kind) return { entries: this.all, exts: null };
    const exts = extensionsForKind(kind);
    if (!exts) {
      return {
        entries: [],
        exts: null,
        error: `Unknown kind "${kind}". Valid kinds: see index_status, or pass a raw extension like "vmdl_c".`,
      };
    }
    return { entries: this.all.filter((ie) => exts.has(ie.e.ext)), exts };
  }

  private toResult(ie: IndexedEntry): AssetResult {
    return { path: ie.e.path, kind: ie.kind, size: ie.e.size, source: ie.source };
  }

  /** Substring or glob (`*`) search over asset paths, case-insensitive. */
  find(
    query: string,
    opts: { kind?: string; limit?: number; offset?: number } = {},
  ): FindResult {
    const limit = clamp(opts.limit ?? 50, 1, 500);
    const offset = Math.max(0, opts.offset ?? 0);
    const { entries, error } = this.pool(opts.kind);
    if (error) return { query, kind: opts.kind ?? null, total: 0, count: 0, offset, results: [] };

    let pred: (lp: string) => boolean;
    if (query.includes('*')) {
      const re = globToRegExp(query.toLowerCase());
      pred = (lp) => re.test(lp);
    } else {
      const q = query.toLowerCase();
      pred = (lp) => lp.includes(q);
    }

    const matches: IndexedEntry[] = [];
    for (const ie of entries) if (pred(ie.lowerPath)) matches.push(ie);
    matches.sort(
      (a, b) => a.e.path.length - b.e.path.length || (a.e.path < b.e.path ? -1 : 1),
    );

    const page = matches.slice(offset, offset + limit).map((ie) => this.toResult(ie));
    return {
      query,
      kind: opts.kind ?? null,
      total: matches.length,
      count: page.length,
      offset,
      results: page,
    };
  }

  /**
   * Typo-tolerant lookup: substring hits first, then a bounded fuzzy scan. The
   * fuzzy pass compares against the file name (with and without extension) AND,
   * for path-like queries, the full path — so typos in directory segments and a
   * stray/wrong extension still resolve to the right asset.
   */
  resolve(name: string, opts: { kind?: string; limit?: number } = {}): ResolveResult {
    const limit = clamp(opts.limit ?? 10, 1, 50);
    const { entries, error } = this.pool(opts.kind);
    if (error) return { query: name, kind: opts.kind ?? null, results: [] };

    const q = name.toLowerCase().trim().replace(/\\/g, '/');
    const hasSlash = q.includes('/');
    const qBase = hasSlash ? q.slice(q.lastIndexOf('/') + 1) : q;
    const dot = qBase.indexOf('.');
    const qBaseNoExt = dot > 0 ? qBase.slice(0, dot) : qBase;
    const qHasExt = dot > 0;

    const scored: { ie: IndexedEntry; score: number }[] = [];
    const seen = new Set<IndexedEntry>();

    // Pass 1: substring on the full path (high confidence).
    for (const ie of entries) {
      if (!ie.lowerPath.includes(q)) continue;
      const fileName = ie.lowerName + (ie.e.ext ? '.' + ie.e.ext : '');
      let score: number;
      if (fileName === qBase || ie.lowerName === qBaseNoExt) score = 1;
      else score = 0.85 + (q.length / ie.lowerPath.length) * 0.15;
      scored.push({ ie, score: Math.min(score, 1) });
      seen.add(ie);
    }

    // Pass 2: bounded edit-distance fuzzy scan (only if we still need more).
    if (scored.length < limit && qBaseNoExt.length >= 2) {
      const nameCap = Math.max(2, Math.floor(qBase.length * 0.5));
      const pathCap = hasSlash ? Math.max(2, Math.floor(q.length * 0.4)) : 0;
      for (const ie of entries) {
        if (seen.has(ie)) continue;

        // File-name similarity (with and without extension).
        let nameScore = 0;
        const dName = boundedLevenshtein(qBaseNoExt, ie.lowerName, nameCap);
        if (dName <= nameCap) {
          nameScore = 1 - dName / Math.max(qBaseNoExt.length, ie.lowerName.length, 1);
        }
        if (qHasExt) {
          const fileName = ie.lowerName + (ie.e.ext ? '.' + ie.e.ext : '');
          const dFile = boundedLevenshtein(qBase, fileName, nameCap);
          if (dFile <= nameCap) {
            nameScore = Math.max(nameScore, 1 - dFile / Math.max(qBase.length, fileName.length, 1));
          }
        }

        // For path-like queries, the full-path match dominates so the right
        // directory wins over a same-basename file elsewhere.
        let score: number;
        if (hasSlash) {
          let pathScore = 0;
          const dPath = boundedLevenshtein(q, ie.lowerPath, pathCap);
          if (dPath <= pathCap) {
            pathScore = 1 - dPath / Math.max(q.length, ie.lowerPath.length, 1);
          }
          score = 0.7 * pathScore + 0.3 * nameScore;
        } else {
          score = nameScore;
        }

        if (score >= 0.34) scored.push({ ie, score: score * 0.95 });
      }
    }

    // De-duplicate by path (keep the highest score) as a safeguard.
    const bestByPath = new Map<string, { ie: IndexedEntry; score: number }>();
    for (const s of scored) {
      const prev = bestByPath.get(s.ie.e.path);
      if (!prev || s.score > prev.score) bestByPath.set(s.ie.e.path, s);
    }
    const deduped = [...bestByPath.values()];

    deduped.sort((a, b) => b.score - a.score || a.ie.e.path.length - b.ie.e.path.length);
    return {
      query: name,
      kind: opts.kind ?? null,
      results: deduped.slice(0, limit).map(({ ie, score }) => ({
        ...this.toResult(ie),
        score: Math.round(score * 1000) / 1000,
      })),
    };
  }

  /** Lists immediate children (sub-directories and files) under a path prefix. */
  listDir(prefix: string, cap = 200): ListDirResult {
    const p = prefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
    const base = p ? p + '/' : '';

    const dirs = new Map<string, number>();
    const files: IndexedEntry[] = [];
    for (const ie of this.all) {
      const lp = ie.lowerPath;
      if (base && !lp.startsWith(base)) continue;
      const rest = lp.slice(base.length);
      const slash = rest.indexOf('/');
      if (slash === -1) files.push(ie);
      else {
        const d = rest.slice(0, slash);
        dirs.set(d, (dirs.get(d) ?? 0) + 1);
      }
    }

    const dirList = [...dirs.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([name, count]) => ({ name, count }));
    files.sort((a, b) => (a.e.path < b.e.path ? -1 : 1));

    return {
      prefix: p,
      dirCount: dirList.length,
      fileCount: files.length,
      dirs: dirList.slice(0, cap),
      files: files.slice(0, cap).map((ie) => this.toResult(ie)),
    };
  }

  /** Looks up an indexed entry by path (case-insensitive, tolerating backslashes). */
  private lookup(path: string): IndexedEntry | undefined {
    return this.byPath.get(path.replace(/\\/g, '/').toLowerCase());
  }

  /** True if the exact path exists in the index. */
  has(path: string): boolean {
    return this.lookup(path) !== undefined;
  }

  /** All indexed paths. */
  get paths(): IterableIterator<string> {
    return this.byPath.keys();
  }

  /**
   * Reads the raw bytes of an asset by exact path, with its metadata. Returns
   * null if the path doesn't exist.
   */
  read(path: string): ReadResult | null {
    const ie = this.lookup(path);
    if (!ie) return null;
    return {
      bytes: ie.provider.readFull(ie.e),
      path: ie.e.path,
      kind: ie.kind,
      ext: ie.e.ext,
      source: ie.source,
      crc: ie.e.crc >>> 0,
      size: ie.e.size,
    };
  }

  /** Metadata for an exact path; on a miss, returns fuzzy suggestions. */
  stat(path: string): StatResult {
    const ie = this.lookup(path);
    if (!ie) {
      return {
        path,
        exists: false,
        suggestions: this.resolve(path, { limit: 5 }).results,
      };
    }
    return {
      path: ie.e.path,
      exists: true,
      kind: ie.kind,
      size: ie.e.size,
      source: ie.source,
      archiveIndex: ie.e.archiveIndex,
      entryLength: ie.e.entryLength,
      preloadBytes: ie.e.preloadBytes,
      crc32: ie.e.crc >>> 0,
    };
  }

  /**
   * Reads the RERL (external references) block of every entry whose kind is in
   * `kinds`, invoking `cb` with the referenced asset paths. Reuses one file
   * descriptor per underlying file (entries are grouped by source) so a full
   * pass over 100k+ files is I/O-cheap — only the header chunk + RERL block of
   * each file are read. Used by the dependency graph.
   */
  scanRerl(
    kinds: Set<string>,
    cb: (info: { path: string; kind: string; crc: number; refs: string[]; source: string }) => void,
  ): { scanned: number } {
    const subset = this.all.filter((ie) => kinds.has(ie.kind));
    // Group by source for descriptor reuse + sequential locality.
    subset.sort(
      (a, b) =>
        (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) ||
        a.e.archiveIndex - b.e.archiveIndex ||
        a.e.entryOffset - b.e.entryOffset,
    );
    return this.scanEntries(subset, cb);
  }

  /** Scans RERL only for entries belonging to a given source label (e.g. an addon). */
  scanRerlForSource(
    sourceLabel: string,
    kinds: Set<string>,
    cb: (info: { path: string; kind: string; crc: number; refs: string[]; source: string }) => void,
  ): { scanned: number } {
    const subset = this.all.filter((ie) => ie.source === sourceLabel && kinds.has(ie.kind));
    return this.scanEntries(subset, cb);
  }

  /**
   * Scans RERL for the given exact paths (whichever source currently serves each),
   * limited to referrer `kinds`. Used to restore base edges when an addon override
   * is deleted and the path falls back to the base VPK.
   */
  scanRerlForPaths(
    paths: Iterable<string>,
    kinds: Set<string>,
    cb: (info: { path: string; kind: string; crc: number; refs: string[]; source: string }) => void,
  ): { scanned: number } {
    const subset: IndexedEntry[] = [];
    for (const p of paths) {
      const ie = this.lookup(p);
      if (ie && kinds.has(ie.kind)) subset.push(ie);
    }
    return this.scanEntries(subset, cb);
  }

  private scanEntries(
    subset: IndexedEntry[],
    cb: (info: { path: string; kind: string; crc: number; refs: string[]; source: string }) => void,
  ): { scanned: number } {
    const fdCache = new Map<string, number>();
    let scanned = 0;
    try {
      for (const ie of subset) {
        let refs: string[] = [];
        try {
          refs = readRerlRefs(ie.provider, ie.e, fdCache);
        } catch {
          refs = [];
        }
        cb({ path: ie.e.path, kind: ie.kind, crc: ie.e.crc >>> 0, refs, source: ie.source });
        scanned++;
      }
    } finally {
      closeFdCache(fdCache);
    }
    return { scanned };
  }

  /** Source label that currently serves a path (e.g. "addon:foo" or "dota"), or null. */
  sourceOf(path: string): string | null {
    return this.lookup(path)?.source ?? null;
  }

  /** Fingerprint of the loaded sources (for cache invalidation across patches). */
  fingerprint(): string {
    const parts = [...new Set(this.all.map((ie) => ie.provider))].map((p) => p.id);
    return parts.sort().join('|');
  }
}
