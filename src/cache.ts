import { mkdtempSync, rmSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheTtlMs } from './config.js';

/**
 * Minimal in-memory TTL cache. Entries expire after `cacheTtlMs()` and are purged
 * lazily on access plus by a background sweep. We key by the asset's crc32 so a
 * Dota patch (which changes the crc) naturally invalidates the entry.
 */
export class TtlCache<V> {
  private map = new Map<string, { value: V; expires: number }>();

  constructor(private ttl: number = cacheTtlMs()) {
    const t = setInterval(() => this.sweep(), Math.max(30_000, this.ttl / 2));
    (t as { unref?: () => void }).unref?.();
  }

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V): void {
    this.map.set(key, { value, expires: Date.now() + this.ttl });
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, e] of this.map) if (e.expires <= now) this.map.delete(k);
  }
}

const TEMP_ROOT = join(tmpdir(), 'dota2-mcp');

/** Removes leftover temp job directories older than the TTL (called at startup). */
export function sweepTempRoot(): void {
  try {
    mkdirSync(TEMP_ROOT, { recursive: true });
    const cutoff = Date.now() - cacheTtlMs();
    for (const name of readdirSync(TEMP_ROOT)) {
      const p = join(TEMP_ROOT, name);
      try {
        if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Runs `fn` with a fresh ephemeral temp directory and always deletes it
 * afterwards — decompiled artifacts never linger (the "decompile, read, gone"
 * requirement). Returns whatever `fn` returns.
 */
export async function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  mkdirSync(TEMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEMP_ROOT, 'job-'));
  try {
    return await fn(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
