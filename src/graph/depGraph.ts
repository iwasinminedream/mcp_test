import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AssetIndex } from '../index/assetIndex.js';

/**
 * Asset dependency graph: forward edges (X references Y) and their inverse
 * (Y is referenced by X). Built by reading each referrer file's RERL block (the
 * compiled external-reference list) — exact, decompiler-free, and cheap (only
 * the header chunk + RERL block of each file are read). Only edges whose target
 * resolves to a real indexed asset are kept.
 */

/** Asset kinds whose compiled files carry RERL references (graph edge sources). */
export const GRAPH_REFERRER_KINDS = new Set([
  'particle', 'model', 'material', 'soundevent', 'world', 'manifest', 'animation', 'smartprop',
]);
const REFERRER_KINDS = GRAPH_REFERRER_KINDS;
const SCHEMA = 2; // bump to invalidate the on-disk cache when the build logic changes
const CACHE_DIR = join(tmpdir(), 'dota2-mcp', 'graph');

export interface GraphStatus {
  built: boolean;
  buildMs: number;
  scanned: number;
  nodesWithOutgoing: number;
  nodesWithIncoming: number;
  edges: number;
  fromCache: boolean;
}

interface SerializedGraph {
  fingerprint: string;
  schema: number;
  forward: Record<string, string[]>;
}

export class DepGraph {
  private forward = new Map<string, string[]>();
  private reverse = new Map<string, string[]>();
  status: GraphStatus = {
    built: false, buildMs: 0, scanned: 0, nodesWithOutgoing: 0,
    nodesWithIncoming: 0, edges: 0, fromCache: false,
  };

  get built(): boolean {
    return this.status.built;
  }

  /** Canonicalizes a reference path to the form stored in the index (adds _c if needed). */
  private canonical(index: AssetIndex, ref: string): string | null {
    if (index.has(ref)) return ref;
    if (index.has(ref + '_c')) return ref + '_c';
    return null;
  }

  /**
   * Builds the graph. Loads from the on-disk cache when the index fingerprint
   * matches, unless `force` is set. `log` receives progress lines (to stderr).
   */
  build(index: AssetIndex, opts: { force?: boolean; log?: (m: string) => void } = {}): GraphStatus {
    const log = opts.log ?? (() => {});
    const fp = index.fingerprint();
    const t0 = Date.now();

    if (!opts.force && this.loadCache(index, fp)) {
      this.status.buildMs = Date.now() - t0;
      this.status.fromCache = true;
      log(`graph: loaded from cache (${this.status.edges} edges)`);
      return this.status;
    }

    this.forward.clear();
    this.reverse.clear();
    let edges = 0;

    const { scanned } = index.scanRerl(REFERRER_KINDS, ({ path, refs }) => {
      const targets: string[] = [];
      const seen = new Set<string>();
      for (const r of refs) {
        const c = this.canonical(index, r);
        if (!c || c === path || seen.has(c)) continue;
        seen.add(c);
        targets.push(c);
      }
      if (targets.length > 0) {
        this.forward.set(path, targets);
        for (const t of targets) {
          let arr = this.reverse.get(t);
          if (!arr) this.reverse.set(t, (arr = []));
          arr.push(path);
          edges++;
        }
      }
    });

    for (const arr of this.reverse.values()) arr.sort();

    this.status = {
      built: true,
      buildMs: Date.now() - t0,
      scanned,
      nodesWithOutgoing: this.forward.size,
      nodesWithIncoming: this.reverse.size,
      edges,
      fromCache: false,
    };
    this.saveCache(fp);
    log(`graph: built ${edges} edges from ${scanned} files in ${this.status.buildMs}ms`);
    return this.status;
  }

  /** Removes all outgoing edges of `src` (and the matching reverse entries). */
  private removeSource(src: string): void {
    const targets = this.forward.get(src);
    if (!targets) return;
    this.forward.delete(src);
    for (const t of targets) {
      const arr = this.reverse.get(t);
      if (!arr) continue;
      const filtered = arr.filter((s) => s !== src);
      if (filtered.length) this.reverse.set(t, filtered);
      else this.reverse.delete(t);
    }
  }

  /** Sets the outgoing edges of `src` to `targets` (de-duped, self-ref dropped). */
  private setSource(src: string, targets: string[]): void {
    const clean: string[] = [];
    const seen = new Set<string>();
    for (const t of targets) {
      if (t === src || seen.has(t)) continue;
      seen.add(t);
      clean.push(t);
    }
    if (clean.length === 0) {
      this.forward.delete(src);
      return;
    }
    this.forward.set(src, clean);
    for (const t of clean) {
      let arr = this.reverse.get(t);
      if (!arr) this.reverse.set(t, (arr = []));
      arr.push(src);
      arr.sort();
    }
  }

  /**
   * Incrementally rebuilds graph edges for a SUBSET of referrer paths against the
   * current index — used by the addon file watcher so a single recompiled asset
   * doesn't trigger a full 378k-file rescan. `scan` yields {path, refs} for the
   * paths to refresh; `removed` paths have their edges dropped entirely (deleted
   * files). Only the addon's own outgoing edges change; the immutable base graph
   * is untouched. Recomputes status counters and re-persists the cache.
   */
  updatePaths(
    index: AssetIndex,
    scan: (cb: (info: { path: string; refs: string[] }) => void) => void,
    removed: Iterable<string> = [],
    log: (m: string) => void = () => {},
  ): GraphStatus {
    if (!this.status.built) return this.build(index, { log });
    const t0 = Date.now();
    let changed = 0;

    for (const p of removed) {
      this.removeSource(p);
      changed++;
    }
    scan(({ path, refs }) => {
      this.removeSource(path);
      const targets: string[] = [];
      for (const r of refs) {
        const c = this.canonical(index, r);
        if (c) targets.push(c);
      }
      this.setSource(path, targets);
      changed++;
    });

    let edges = 0;
    for (const arr of this.forward.values()) edges += arr.length;
    this.status = {
      built: true,
      buildMs: Date.now() - t0,
      scanned: changed,
      nodesWithOutgoing: this.forward.size,
      nodesWithIncoming: this.reverse.size,
      edges,
      fromCache: false,
    };
    this.saveCache(index.fingerprint());
    log(`graph: incrementally updated ${changed} paths (${edges} edges) in ${this.status.buildMs}ms`);
    return this.status;
  }

  /** Assets that `path` references (outgoing). */
  refsFrom(path: string): string[] {
    return this.forward.get(path) ?? this.forward.get(path.replace(/\\/g, '/')) ?? [];
  }

  /** Assets that reference `path` (incoming / reverse dependencies). */
  refsTo(path: string): string[] {
    return this.reverse.get(path) ?? this.reverse.get(path.replace(/\\/g, '/')) ?? [];
  }

  private cacheFile(fp: string): string {
    const h = createHash('sha1').update(fp + '|v' + SCHEMA).digest('hex').slice(0, 16);
    return join(CACHE_DIR, `graph-${h}.json`);
  }

  private loadCache(_index: AssetIndex, fp: string): boolean {
    const file = this.cacheFile(fp);
    if (!existsSync(file)) return false;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as SerializedGraph;
      if (data.fingerprint !== fp || data.schema !== SCHEMA) return false;
      this.forward = new Map(Object.entries(data.forward));
      this.reverse.clear();
      let edges = 0;
      for (const [src, targets] of this.forward) {
        for (const t of targets) {
          let arr = this.reverse.get(t);
          if (!arr) this.reverse.set(t, (arr = []));
          arr.push(src);
          edges++;
        }
      }
      for (const arr of this.reverse.values()) arr.sort();
      this.status = {
        built: true, buildMs: 0, scanned: this.forward.size,
        nodesWithOutgoing: this.forward.size, nodesWithIncoming: this.reverse.size,
        edges, fromCache: true,
      };
      return true;
    } catch {
      return false;
    }
  }

  private saveCache(fp: string): void {
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      const forward: Record<string, string[]> = {};
      for (const [k, v] of this.forward) forward[k] = v;
      const data: SerializedGraph = { fingerprint: fp, schema: SCHEMA, forward };
      writeFileSync(this.cacheFile(fp), JSON.stringify(data));
    } catch {
      /* cache is best-effort */
    }
  }
}
