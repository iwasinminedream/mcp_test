import { watch, type FSWatcher } from 'node:fs';
import type { LooseDir } from './looseDir.js';
import type { AssetIndex } from '../index/assetIndex.js';
import type { DepGraph } from '../graph/depGraph.js';
import { GRAPH_REFERRER_KINDS } from '../graph/depGraph.js';
import { kindForExt } from '../kinds.js';

/**
 * Watches the active addon's folder and keeps the index + dependency graph in
 * sync as the modder recompiles assets — so search/introspection/graph reflect
 * the live addon without a manual reindex or server restart.
 *
 * Scope discipline (matches the user's intent):
 *  - Only COMPILED ASSETS trigger work: paths ending in `_c` (vpcf_c, vmdl_c,
 *    vmat_c, vtex_c, …). `scripts/` (Lua/KV/cfg) and other non-asset files are
 *    ignored — they change often and are not part of the asset graph anyway.
 *  - Updates are INCREMENTAL and ADDON-SCOPED: only the changed addon files are
 *    re-scanned and only the addon's graph edges are recomputed. The immutable
 *    base-VPK graph (≈378k files) is never rescanned.
 *  - Events are DEBOUNCED so a burst of writes (a compile dumping many files)
 *    collapses into one update.
 */

const DEBOUNCE_MS = (() => {
  const v = Number(process.env.ADDON_WATCH_DEBOUNCE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 400;
})();

// Minimum wall-clock gap between the END of one sync and the START of the next.
// Under a recompile storm (the addon's `game/` is junctioned into the live Steam
// install, so the game/tools can churn it continuously) this throttles how often
// the (cooperative but still CPU-bound) re-index runs, keeping the request loop free.
const MIN_INTERVAL_MS = (() => {
  const v = Number(process.env.ADDON_WATCH_MIN_INTERVAL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 2000;
})();

/** True if a relative path is a compiled asset we care about (not scripts/etc). */
function isWatchedAsset(rel: string): boolean {
  const lower = rel.replace(/\\/g, '/').toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = lower.slice(dot + 1);
  // Only compiled resources (the *_c family). This excludes scripts/ (lua/txt/cfg),
  // panorama source, addoninfo, thumbnails, sqlite, etc.
  if (!ext.endsWith('_c')) return false;
  return kindForExt(ext) !== 'other';
}

export interface AddonWatcher {
  close(): void;
  readonly stats: { events: number; updates: number; lastUpdateMs: number };
}

/**
 * Starts watching `addonDir`. On a debounced batch of compiled-asset changes it:
 *   1) reloads the LooseDir (diff changed/removed),
 *   2) re-finalizes the index (so search/stat/read see new files + overrides),
 *   3) incrementally updates the graph: re-scan changed addon referrers, drop
 *      removed ones, and restore base edges for paths whose addon override was
 *      deleted (so refs fall back to the base VPK).
 *
 * Returns a handle with close() and live stats. Safe no-op if the dir can't be
 * watched. `rebuild()` is called when the index identity must be refreshed
 * (finalize happens inside it); pass a closure that re-finalizes the shared index.
 */
export function startAddonWatcher(opts: {
  addonDir: LooseDir;
  index: AssetIndex;
  graph: DepGraph;
  refinalize: () => void | Promise<void>;
  log?: (m: string) => void;
}): AddonWatcher {
  const { addonDir, index, graph, refinalize } = opts;
  const log = opts.log ?? (() => {});
  const stats = { events: 0, updates: 0, lastUpdateMs: 0 };

  let timer: NodeJS.Timeout | null = null;
  let running = false; // an update is in flight (re-entrancy guard; updates never overlap)
  let dirty = false; // events arrived since the last update was scheduled → a sync is wanted
  let lastEndMs = 0; // wall clock when the last update finished (for throttling)
  let watcher: FSWatcher | null = null;

  const runUpdate = async (): Promise<void> => {
    running = true;
    const t0 = Date.now();
    try {
      let diff: { changed: string[]; removed: string[] };
      try {
        diff = addonDir.reload();
      } catch (err) {
        log(`watch: reload failed: ${err instanceof Error ? err.message : err}`);
        return;
      }
      if (diff.changed.length === 0 && diff.removed.length === 0) return;

      // 1) Index must reflect the new file set (added/removed/override changes).
      //    Cooperative: yields to the event loop so MCP calls stay responsive.
      await refinalize();

      // 2) Only update the graph if the change set includes compiled assets.
      const changedAssets = diff.changed.filter(isWatchedAsset);
      const removedAssets = diff.removed.filter(isWatchedAsset);
      if (changedAssets.length === 0 && removedAssets.length === 0) {
        log(`watch: ${diff.changed.length} changed / ${diff.removed.length} removed (no compiled assets; graph untouched)`);
        return;
      }

      if (graph.built) {
        // Re-scan changed addon referrers; for removed addon overrides, re-scan the
        // path so its edges come from whatever source now serves it (base VPK), or
        // drop them if the path no longer exists at all.
        const removedGone: string[] = [];
        const fellBack: string[] = [];
        for (const p of removedAssets) {
          if (index.has(p)) fellBack.push(p);
          else removedGone.push(p);
        }
        graph.updatePaths(
          index,
          (cb) => {
            // changed addon assets (only referrer kinds matter for the graph)
            index.scanRerlForSource(
              addonDir.source,
              GRAPH_REFERRER_KINDS,
              ({ path, refs }) => cb({ path, refs }),
            );
            // paths that fell back to base after an override was deleted
            if (fellBack.length) {
              index.scanRerlForPaths(fellBack, GRAPH_REFERRER_KINDS, ({ path, refs }) =>
                cb({ path, refs }),
              );
            }
          },
          removedGone,
          log,
        );
      }

      stats.updates++;
      stats.lastUpdateMs = Date.now() - t0;
      log(
        `watch: synced ${changedAssets.length} changed, ${removedAssets.length} removed asset(s) ` +
          `in ${stats.lastUpdateMs}ms`,
      );
    } finally {
      running = false;
      lastEndMs = Date.now();
      if (dirty) arm(); // events arrived during the run → schedule a trailing sync
    }
  };

  // Fires after the debounce; enforces the throttle and the no-overlap guard.
  const fire = (): void => {
    timer = null;
    if (running) return; // runUpdate's finally re-arms when it finishes
    const since = Date.now() - lastEndMs;
    if (since < MIN_INTERVAL_MS) {
      timer = setTimeout(fire, MIN_INTERVAL_MS - since); // throttle: wait out the gap
      timer.unref?.();
      return;
    }
    dirty = false;
    void runUpdate();
  };

  const arm = (): void => {
    if (timer || running) return;
    timer = setTimeout(fire, DEBOUNCE_MS);
    timer.unref?.();
  };

  const schedule = (): void => {
    stats.events++;
    dirty = true;
    arm();
  };

  try {
    watcher = watch(addonDir.rootDir, { recursive: true }, (_event, filename) => {
      if (!filename) {
        schedule(); // unknown file → conservatively re-check
        return;
      }
      const rel = String(filename).replace(/\\/g, '/');
      // Cheap pre-filter: ignore obvious non-asset churn (scripts/, dotfiles,
      // thumbnails). Real asset relevance is re-confirmed in runUpdate via diff.
      if (/^scripts\//i.test(rel) || /(^|\/)\./.test(rel)) return;
      if (!/_c$/i.test(rel) && !/_c[/\\]/i.test(rel)) {
        // Editors write temp names; still allow if it could become a _c. Cheapest
        // correct behavior: only schedule when the name hints at a compiled asset.
        if (!/\._?c?$/i.test(rel) && !rel.includes('_c')) return;
      }
      schedule();
    });
    log(`watch: watching addon dir ${addonDir.rootDir} (compiled assets only, scripts/ ignored)`);
  } catch (err) {
    log(`watch: could not watch ${addonDir.rootDir}: ${err instanceof Error ? err.message : err}`);
  }

  return {
    stats,
    close() {
      if (timer) clearTimeout(timer);
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
    },
  };
}
