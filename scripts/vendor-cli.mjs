// Downloads the Source2Viewer-CLI executable + its runtime DLLs into vendor/ so
// the server can decompile particles/materials with no external install. The
// server finds this copy automatically (see resolveCliPath in src/config.ts).
//
// Default: fetch the latest release from
//   https://github.com/ValveResourceFormat/ValveResourceFormat/releases
// Overrides:
//   S2V_CLI_DIR  — copy from a local install instead of downloading (offline dev)
//   S2V_CLI_TAG  — pin a release tag (e.g. "19.2") instead of "latest"
//   S2V_CLI_TARGET — another OS/arch than this machine, as <win32|darwin|linux>-<x64|arm64>
//                  (used by `npm run package -- --target ...` to build a Mac/Linux release on Windows)
//   S2V_CLI_DEST — destination dir (default vendor/Source2Viewer-CLI)
//   FORCE=1      — re-download even if the destination already has the CLI
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const [targetOs, targetArch] = (process.env.S2V_CLI_TARGET || `${process.platform}-${process.arch}`).split('-');
const dst = resolve(process.env.S2V_CLI_DEST || join(process.cwd(), 'vendor', 'Source2Viewer-CLI'));
const exe = targetOs === 'win32' ? 'Source2Viewer-CLI.exe' : 'Source2Viewer-CLI';

// Already vendored? Skip unless forced.
if (existsSync(join(dst, exe)) && !process.env.FORCE) {
  console.log(`Source2Viewer-CLI already present in ${dst} (set FORCE=1 to re-download)`);
  process.exit(0);
}

// --- Offline path: copy from a local install when S2V_CLI_DIR is set. ---
if (process.env.S2V_CLI_DIR) {
  const src = process.env.S2V_CLI_DIR;
  if (!existsSync(join(src, exe))) {
    console.error(`S2V_CLI_DIR set but "${join(src, exe)}" not found.`);
    process.exit(1);
  }
  mkdirSync(dst, { recursive: true });
  let total = 0;
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    if (!statSync(s).isFile()) continue;
    cpSync(s, join(dst, name));
    total += statSync(s).size;
  }
  console.log(`copied Source2Viewer-CLI -> ${dst} (${(total / 1e6).toFixed(0)} MB)`);
  process.exit(0);
}

// --- Map platform/arch to the release asset name (cli-<os>-<arch>.zip). ---
const OS = { win32: 'windows', darwin: 'macos', linux: 'linux' }[targetOs];
const ARCH = { x64: 'x64', arm64: 'arm64', arm: 'arm' }[targetArch];
if (!OS || !ARCH) {
  console.error(`Unsupported platform/arch: ${targetOs}/${targetArch}`);
  process.exit(1);
}
const asset = `cli-${OS}-${ARCH}.zip`;

const tag = process.env.S2V_CLI_TAG || 'latest';
const apiUrl =
  tag === 'latest'
    ? 'https://api.github.com/repos/ValveResourceFormat/ValveResourceFormat/releases/latest'
    : `https://api.github.com/repos/ValveResourceFormat/ValveResourceFormat/releases/tags/${tag}`;

const headers = { 'User-Agent': 'dota2-mcp-vendor' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

console.log(`Resolving Source2Viewer-CLI release (${tag}) for ${asset}...`);
const relRes = await fetch(apiUrl, { headers });
if (!relRes.ok) {
  console.error(`GitHub API ${relRes.status} ${relRes.statusText} for ${apiUrl}`);
  process.exit(1);
}
const release = await relRes.json();
const found = (release.assets || []).find((a) => a.name === asset);
if (!found) {
  console.error(
    `Asset "${asset}" not found in release ${release.tag_name}. Available:\n  ` +
      (release.assets || []).map((a) => a.name).join('\n  '),
  );
  process.exit(1);
}

// --- Download the zip to a temp file. ---
const zipPath = join(tmpdir(), `s2v-cli-${release.tag_name}-${asset}`);
console.log(`Downloading ${found.browser_download_url} ...`);
const dlRes = await fetch(found.browser_download_url, { headers, redirect: 'follow' });
if (!dlRes.ok) {
  console.error(`Download failed: ${dlRes.status} ${dlRes.statusText}`);
  process.exit(1);
}
writeFileSync(zipPath, Buffer.from(await dlRes.arrayBuffer()));

// --- Extract into the destination (fresh). ---
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
let unzip;
if (process.platform === 'win32') {
  unzip = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dst}' -Force`],
    { stdio: 'inherit' },
  );
} else {
  unzip = spawnSync('unzip', ['-o', '-q', zipPath, '-d', dst], { stdio: 'inherit' });
  // no unzip (minimal Linux): bsdtar reads zip too
  if (unzip.status !== 0) unzip = spawnSync('bsdtar', ['-xf', zipPath, '-C', dst], { stdio: 'inherit' });
}
rmSync(zipPath, { force: true });
if (unzip.status !== 0) {
  console.error('Extraction failed. Ensure PowerShell (Windows) or `unzip` (macOS/Linux) is available.');
  process.exit(1);
}

// The macOS/Linux binary needs the execute bit. On a Windows host (cross-target
// packaging) NTFS has no such bit; the release's install.sh sets it instead.
if (process.platform !== 'win32' && targetOs !== 'win32' && existsSync(join(dst, exe))) {
  spawnSync('chmod', ['+x', join(dst, exe)]);
}

const total = readdirSync(dst).reduce((n, f) => {
  try {
    return n + statSync(join(dst, f)).size;
  } catch {
    return n;
  }
}, 0);
console.log(`vendored Source2Viewer-CLI ${release.tag_name} -> ${dst} (${(total / 1e6).toFixed(0)} MB)`);
