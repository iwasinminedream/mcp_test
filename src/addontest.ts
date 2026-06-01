// Verifies the ACTIVE addon (resolved from ADDON_PATH / CLAUDE_PROJECT_DIR / cwd,
// including the symlinked `<project>/game` layout) is indexed alongside the base
// VPKs, searchable, and in the dependency graph. Prints one RESULT:{json} line.
import { buildIndex } from './indexer.js';
import { DepGraph } from './graph/depGraph.js';

const { index, status } = buildIndex();
const addon = status.addons[0];

// Reach into the index to enumerate addon-sourced entries.
const all = (index as unknown as { all: { source: string; kind: string; e: { path: string; ext: string } }[] }).all;
const addonEntries = all.filter((ie) => ie.source.startsWith('addon:'));
const sample = addonEntries.slice(0, 8).map((ie) => `[${ie.kind}] ${ie.e.path}`);
const addonPcf = addonEntries.find((ie) => ie.e.ext === 'vpcf_c');
const stat = addonPcf ? index.stat(addonPcf.e.path) : { exists: false };

// Graph includes addon referrers + their refs resolve?
const g = new DepGraph();
g.build(index, { force: true, log: () => {} });
const graphFromAddon = addonPcf ? g.refsFrom(addonPcf.e.path) : [];

const result = {
  totalAssets: status.totalAssets,
  addon: addon ? { source: addon.source, count: addon.count, via: addon.via, dir: addon.dir } : null,
  addonEntriesInIndex: addonEntries.length,
  sample,
  statExists: stat.exists,
  statSource: (stat as { source?: string }).source,
  graphFromAddonCount: graphFromAddon.length,
  graphFromAddonSample: graphFromAddon.slice(0, 4),
  graphEdges: g.status.edges,
};

const pass =
  !!addon && addon.source.startsWith('addon:') && addon.count > 100 &&
  addonEntries.length > 100 &&
  stat.exists === true && (stat as { source?: string }).source?.startsWith('addon:') === true &&
  status.totalAssets > 372000;

console.log('RESULT:' + JSON.stringify(result));
console.log(pass ? 'ADDON_PASS' : 'ADDON_FAIL');
process.exit(pass ? 0 : 1);
