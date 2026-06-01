// Downloads the Source2Viewer-CLI executable + its runtime DLLs into vendor/ so
// the server can decompile particles/materials with no external install. The
// server finds this copy automatically (see resolveCliPath in src/config.ts).
//
// Default: fetch the latest release from
//   https://github.com/ValveResourceFormat/ValveResourceFormat/releases
// Overrides:
//   S2V_CLI_DIR  — copy from a local install instead of downloading (offline dev)
//   S2V_CLI_TAG  — pin a release tag (e.g. "19.2") instead of "latest"
//   FORCE=1      — re-download even if vendor/Source2Viewer-CLI already exists
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const dst = join(process.cwd(), 'vendor', 'Source2Viewer-CLI');
const exe = process.platform === 'win32' ? 'Source2Viewer-CLI.exe' : 'Source2Viewer-CLI';

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
const OS = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
const ARCH = { x64: 'x64', arm64: 'arm64', arm: 'arm' }[process.arch];
if (!OS || !ARCH) {
  console.error(`Unsupported platform/arch: ${process.platform}/${process.arch}`);
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

// --- Extract into vendor/Source2Viewer-CLI (fresh). ---
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
const unzip =
  process.platform === 'win32'
    ? spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dst}' -Force`],
        { stdio: 'inherit' },
      )
    : spawnSync('unzip', ['-o', zipPath, '-d', dst], { stdio: 'inherit' });
rmSync(zipPath, { force: true });
if (unzip.status !== 0) {
  console.error('Extraction failed. Ensure PowerShell (Windows) or `unzip` (macOS/Linux) is available.');
  process.exit(1);
}

// On non-Windows the binary needs the execute bit.
if (process.platform !== 'win32' && existsSync(join(dst, exe))) {
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
