// Downloads the Dota 2 API JSON dumps into vendor/dota-data so the API tools work
// with no external repos. Only the JSON the server actually reads is fetched (NOT
// the large changelog-states). The server finds these via resolveDotaDataDir.
// (ModDota tutorial articles are intentionally NOT vendored — they are often
// outdated and can mislead.)
//
// Default: download from
//   https://github.com/iwasinminedream/dota-data (files/ on the master branch)
// Overrides:
//   DOTA_DATA_DIR   — copy from a local "files" dir instead of downloading
//   DOTA_DATA_REPO  — owner/repo (default iwasinminedream/dota-data)
//   DOTA_DATA_REF   — branch/tag/commit (default master)
//   DOTA_DATA_LANGS — comma-separated localization languages to fetch
//                     (default "english,russian"; localization files are ~10 MB each)
//   FORCE=1         — re-fetch even if vendor/dota-data already exists
import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const root = process.cwd();
const dataDst = join(root, 'vendor', 'dota-data');

// Localization languages to vendor (each ~10 MB; default = English + the user's
// Russian). Override with DOTA_DATA_LANGS="english,russian,schinese".
const LANGS = (process.env.DOTA_DATA_LANGS || 'english,russian')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const NEEDED = [
  'vscripts/api.json',
  'vscripts/enums.json',
  'vscripts/api-types.json',
  'vscripts/modifier_properties.json',
  'vscripts/modifier_list.json',
  'panorama/api.json',
  'panorama/css.json',
  'panorama/enums.json',
  'panorama/events.json',
  'events.json',
  'engine-enums.json',
  // Real game KeyValues (abilities/heroes/units) + the ability→hero map.
  'abilities.json',
  'heroes.json',
  'units.json',
  'ability-hero-map.json',
  // Per-language localization strings (tooltips, names, descriptions).
  ...LANGS.map((l) => `localization/${l}.json`),
];

// Already fully vendored? Skip unless forced. Use a NEW required file as the
// marker so older partial vendors (without the game KV) get topped up.
if (existsSync(join(dataDst, 'abilities.json')) && !process.env.FORCE) {
  console.log(`dota-data already present in ${dataDst} (set FORCE=1 to re-fetch)`);
  process.exit(0);
}

// --- Offline path: copy from a local "files" dir when DOTA_DATA_DIR is set. ---
if (process.env.DOTA_DATA_DIR) {
  const DATA_SRC = process.env.DOTA_DATA_DIR;
  if (!existsSync(DATA_SRC)) {
    console.error(`DOTA_DATA_DIR set but "${DATA_SRC}" not found.`);
    process.exit(1);
  }
  let bytes = 0;
  let files = 0;
  for (const rel of NEEDED) {
    const src = join(DATA_SRC, rel);
    if (!existsSync(src)) continue;
    const dst = join(dataDst, rel);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
    bytes += statSync(dst).size;
    files++;
  }
  console.log(`copied dota-data -> ${dataDst} (${files} files, ${(bytes / 1e6).toFixed(1)} MB)`);
  process.exit(0);
}

// --- Download each needed file from raw.githubusercontent.com. ---
const repo = process.env.DOTA_DATA_REPO || 'iwasinminedream/dota-data';
const ref = process.env.DOTA_DATA_REF || 'master';
const base = `https://raw.githubusercontent.com/${repo}/${ref}/files`;
const headers = { 'User-Agent': 'dota2-mcp-vendor' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

console.log(`Downloading dota-data from ${repo}@${ref} ...`);
let bytes = 0;
let files = 0;
const missing = [];
for (const rel of NEEDED) {
  const url = `${base}/${rel}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    missing.push(`${rel} (${res.status})`);
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const dst = join(dataDst, rel);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, buf);
  bytes += buf.length;
  files++;
}

if (files === 0) {
  console.error(`No dota-data files downloaded from ${repo}@${ref}. Check the repo/ref.`);
  process.exit(1);
}
console.log(`vendored dota-data -> ${dataDst} (${files} files, ${(bytes / 1e6).toFixed(1)} MB)`);
if (missing.length) console.warn(`  skipped (not in repo): ${missing.join(', ')}`);
