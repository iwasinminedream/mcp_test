import { resolveVpkRoots, resolveGameDir, resolveActiveAddon } from './config.js';
import { VpkArchive } from './vpk/reader.js';
import { LooseDir } from './loose/looseDir.js';
import { AssetIndex } from './index/assetIndex.js';

export interface IndexStatus {
  ready: boolean;
  error: string | null;
  gameDir: string;
  totalAssets: number;
  buildMs: number;
  archives: { source: string; path: string; count: number }[];
  addons: { source: string; dir: string; count: number; via: string }[];
}

export interface BuiltIndex {
  index: AssetIndex;
  status: IndexStatus;
  /** The active addon's loose-file source (for the live watcher), or null. */
  addonDir: LooseDir | null;
  /** The active addon's source label (e.g. "addon:rda_game"), or null. */
  addonSource: string | null;
}

/**
 * Builds the in-memory asset index from (1) the currently-open addon's loose
 * files and (2) the base VPK packages. The addon folder is added FIRST so its
 * compiled assets override base-game assets with the same path (matching engine
 * search-path behavior). Only the active addon is indexed — see resolveActiveAddon.
 */
export function buildIndex(log: (...a: unknown[]) => void = () => {}): BuiltIndex {
  const t0 = Date.now();
  const index = new AssetIndex();
  const status: IndexStatus = {
    ready: false,
    error: null,
    gameDir: resolveGameDir(),
    totalAssets: 0,
    buildMs: 0,
    archives: [],
    addons: [],
  };

  // (1) The active addon's loose files (highest priority).
  let addonDir: LooseDir | null = null;
  let addonSource: string | null = null;
  const addon = resolveActiveAddon();
  if (addon) {
    try {
      const dir = new LooseDir(addon.dir, addon.source);
      dir.load();
      if (dir.count > 0) {
        index.addSource(dir);
        addonDir = dir;
        addonSource = addon.source;
        status.addons.push({ source: addon.source, dir: addon.dir, count: dir.count, via: addon.via });
        log(`loaded ${addon.source}: ${dir.count} loose files from ${addon.dir} (via ${addon.via})`);
      }
    } catch (err) {
      log(`failed to load addon ${addon.dir}:`, err instanceof Error ? err.message : err);
    }
  }

  // (2) Base VPK packages.
  const roots = resolveVpkRoots();
  if (roots.length === 0 && status.addons.length === 0) {
    status.error =
      `No Dota 2 VPK found under "${status.gameDir}". ` +
      `Set the DOTA_PATH env var to your ".../dota 2 beta/game" folder.`;
    status.buildMs = Date.now() - t0;
    log(status.error);
    return { index, status, addonDir, addonSource };
  }

  for (const root of roots) {
    try {
      const archive = new VpkArchive(root.path, root.source);
      archive.load();
      index.addSource(archive);
      status.archives.push({
        source: root.source,
        path: root.path,
        count: archive.entries.size,
      });
      log(`loaded ${root.source}: ${archive.entries.size} entries from ${root.path}`);
    } catch (err) {
      log(`failed to load ${root.path}:`, err instanceof Error ? err.message : err);
    }
  }

  index.finalize();
  status.ready = index.size > 0;
  status.totalAssets = index.size;
  status.buildMs = Date.now() - t0;
  if (!status.ready && !status.error) status.error = 'Index is empty (all sources failed to load).';
  log(`index ready: ${status.totalAssets} assets in ${status.buildMs}ms`);
  return { index, status, addonDir, addonSource };
}
