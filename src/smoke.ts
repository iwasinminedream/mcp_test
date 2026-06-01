// Standalone smoke test for the M1 VPK index (no MCP). Run: npm run smoke
import { buildIndex } from './indexer.js';

const log = (...a: unknown[]) => console.log(...a);

const { index, status } = buildIndex(log);
console.log('\n=== STATUS ===');
console.log(JSON.stringify(status, null, 2));
if (!status.ready) process.exit(1);

const mem = process.memoryUsage();
console.log(`\nheapUsed: ${(mem.heapUsed / 1e6).toFixed(0)} MB, rss: ${(mem.rss / 1e6).toFixed(0)} MB`);

function section<T>(title: string, fn: () => T): void {
  const t = Date.now();
  const r = fn();
  console.log(`\n=== ${title} (${Date.now() - t}ms) ===`);
  console.log(JSON.stringify(r, null, 2));
}

section('find_assets axe (kind=model, limit 8)', () =>
  index.find('axe', { kind: 'model', limit: 8 }),
);
section('find_assets glob particles/units/heroes/hero_axe/*.vpcf_c (limit 8)', () =>
  index.find('particles/units/heroes/hero_axe/*.vpcf_c', { limit: 8 }),
);
section('resolve typo "modls/heros/axe/axe.vmdl_c"', () =>
  index.resolve('modls/heros/axe/axe.vmdl_c', { limit: 5 }),
);
section('list_dir particles/units/heroes (capped)', () => {
  const r = index.listDir('particles/units/heroes');
  return { prefix: r.prefix, dirCount: r.dirCount, fileCount: r.fileCount, dirs: r.dirs.slice(0, 10), files: r.files.slice(0, 5) };
});
section('stat models/heroes/axe/axe.vmdl_c', () =>
  index.stat('models/heroes/axe/axe.vmdl_c'),
);
section('stat (miss) models/heroes/axe/ax.vmdl_c -> suggestions', () =>
  index.stat('models/heroes/axe/ax.vmdl_c'),
);
