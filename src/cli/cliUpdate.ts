// Startup auto-update for the vendored Source2Viewer-CLI.
//
// On every server start (both transports, in the background) we ask GitHub for
// the release tag we want (`S2V_CLI_TAG` or `latest`) and compare it with the tag
// recorded in `vendor/.s2v-cli.json`. If it differs — or the marker is absent
// while an untracked CLI sits in vendor/ — the release zip is downloaded and
// swapped in behind the running server. The marker's `checkedAt` throttles the
// lookup so per-client stdio spawns do not hammer the GitHub API.
//
// The download/extract protocol intentionally mirrors scripts/vendor-cli.mjs
// (the build-time counterpart; keep the two in sync). That script writes the
// same marker after installing, so a fresh `npm run build` and a server start
// agree on what is installed.
//
// Env knobs:
//   S2V_CLI_AUTO_UPDATE=0     — disable the startup check entirely
//   S2V_CLI_TAG               — pin a release tag instead of `latest`
//   S2V_CLI_CHECK_INTERVAL_H  — lookup throttle, hours (default 6)
//   S2V_CLI_UPDATE_FORCE=1    — ignore throttle + equality, (re)install the tag
//   S2V_CLI                   — external exe pinned: vendor/ untouched, no check
//   S2V_VENDOR_ROOT           — vendor dir override (tests)
//   GITHUB_TOKEN              — auth for the GitHub API
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packageRoot } from '../config.js';

const REPO = 'ValveResourceFormat/ValveResourceFormat';
const EXE = process.platform === 'win32' ? 'Source2Viewer-CLI.exe' : 'Source2Viewer-CLI';
const RENAME_RETRIES = 15;
const RENAME_RETRY_MS = 800;

export interface CliUpdateResult {
  checked: boolean;
  updated: boolean;
  from?: string;
  to?: string;
  reason?: string;
}

type Log = (...a: unknown[]) => void;

interface Marker {
  tag?: string;
  checkedAt?: number;
  updatedAt?: number;
}

function vendorRoot(): string {
  return process.env.S2V_VENDOR_ROOT?.trim() || join(packageRoot(), 'vendor');
}
function cliDir(): string {
  return join(vendorRoot(), 'Source2Viewer-CLI');
}
function stagingDir(): string {
  return `${cliDir()}.new`;
}
function oldDir(): string {
  return `${cliDir()}.old`;
}
function markerPath(): string {
  return join(vendorRoot(), '.s2v-cli.json');
}

function readMarker(): { marker: Marker; exists: boolean } {
  try {
    return { marker: JSON.parse(readFileSync(markerPath(), 'utf8')) as Marker, exists: true };
  } catch {
    return { marker: {}, exists: false };
  }
}

function writeMarker(m: Marker): void {
  try {
    mkdirSync(vendorRoot(), { recursive: true });
    writeFileSync(markerPath(), JSON.stringify(m, null, 2));
  } catch {
    // A read-only vendor dir is not worth failing the update flow over.
  }
}

function assetName(): string | null {
  const os = ({ win32: 'windows', darwin: 'macos', linux: 'linux' } as Record<string, string>)[process.platform];
  const arch = ({ x64: 'x64', arm64: 'arm64', arm: 'arm' } as Record<string, string>)[process.arch];
  return os && arch ? `cli-${os}-${arch}.zip` : null;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': 'dota2-mcp-cli-update' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function resolveRelease(
  tag: string,
  signal?: AbortSignal,
): Promise<{ tag: string; url: string; apiUrl: string }> {
  const apiUrl =
    tag === 'latest'
      ? `https://api.github.com/repos/${REPO}/releases/latest`
      : `https://api.github.com/repos/${REPO}/releases/tags/${tag}`;
  const res = await fetch(apiUrl, { headers: headers(), signal });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText} for ${apiUrl}`);
  const release = (await res.json()) as {
    tag_name?: string;
    assets?: { name: string; url: string; browser_download_url: string }[];
  };
  const asset = assetName();
  const found = (release.assets ?? []).find((a) => a.name === asset);
  if (!release.tag_name || !found) {
    throw new Error(`asset "${asset}" not found in release ${release.tag_name ?? tag}`);
  }
  return { tag: release.tag_name, url: found.browser_download_url, apiUrl: found.url };
}

/**
 * Downloads the release zip. `browser_download_url` (GitHub edge -> CDN) is
 * preferred; when it fails (the edge intermittently answers 504 for release
 * downloads) the API asset route with `Accept: application/octet-stream` is
 * tried, which serves the same bytes via a different path.
 */
async function fetchReleaseZip(
  urls: { url: string; apiUrl: string },
  signal?: AbortSignal,
): Promise<Buffer> {
  const routes = [
    { u: urls.url, h: headers() },
    { u: urls.apiUrl, h: { ...headers(), Accept: 'application/octet-stream' } },
  ];
  let lastErr = 'no download routes';
  for (const r of routes) {
    const res = await fetch(r.u, { headers: r.h, redirect: 'follow', signal });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    lastErr = `${res.status} ${res.statusText} for ${r.u}`;
  }
  throw new Error(`download failed: ${lastErr}`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

/** Downloads (or reuses the cached zip) and extracts into the staging dir. */
async function stageRelease(
  tag: string,
  urls: { url: string; apiUrl: string },
  log: Log,
  signal?: AbortSignal,
): Promise<void> {
  const zipPath = join(tmpdir(), `s2v-cli-${tag}-${assetName()}`);
  if (!existsSync(zipPath) || statSync(zipPath).size < 1024 * 1024) {
    log(`cli-update: downloading ${urls.url} …`);
    writeFileSync(zipPath, await fetchReleaseZip(urls, signal));
  } else {
    log(`cli-update: reusing cached zip ${zipPath}`);
  }
  rmSync(stagingDir(), { recursive: true, force: true });
  mkdirSync(stagingDir(), { recursive: true });
  const unzip =
    process.platform === 'win32'
      ? spawnSync(
          'powershell',
          ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${stagingDir()}' -Force`],
          { windowsHide: true },
        )
      : spawnSync('unzip', ['-o', zipPath, '-d', stagingDir()], { windowsHide: true });
  if (unzip.status !== 0) {
    rmSync(stagingDir(), { recursive: true, force: true });
    throw new Error('extraction failed (needs PowerShell on Windows, `unzip` elsewhere)');
  }
  if (!existsSync(join(stagingDir(), EXE))) {
    rmSync(stagingDir(), { recursive: true, force: true });
    throw new Error(`extracted release has no ${EXE}`);
  }
  if (process.platform !== 'win32') spawnSync('chmod', ['+x', join(stagingDir(), EXE)], { windowsHide: true });
}

/**
 * Replaces vendor/Source2Viewer-CLI with the staged copy. A decompile may be
 * holding the old exe open, so the rename-away is retried; on Windows a locked
 * file makes renameSync throw until the process exits.
 */
async function swapStaged(signal?: AbortSignal): Promise<void> {
  rmSync(oldDir(), { recursive: true, force: true });
  if (existsSync(cliDir())) {
    let moved = false;
    for (let i = 0; i < RENAME_RETRIES && !moved; i++) {
      try {
        renameSync(cliDir(), oldDir());
        moved = true;
      } catch {
        await sleep(RENAME_RETRY_MS, signal);
      }
    }
    if (!moved) {
      rmSync(stagingDir(), { recursive: true, force: true });
      throw new Error('vendor/Source2Viewer-CLI is locked by a running decompile; retry next start');
    }
  }
  try {
    renameSync(stagingDir(), cliDir());
  } catch (err) {
    try {
      renameSync(oldDir(), cliDir());
    } catch {
      // Old copy is gone and the swap failed: next start re-installs from scratch.
    }
    throw err;
  }
  rmSync(oldDir(), { recursive: true, force: true });
}

export async function autoUpdateVendorCli(opts: { log?: Log; signal?: AbortSignal } = {}): Promise<CliUpdateResult> {
  const log = opts.log ?? console.error;
  const signal = opts.signal;
  try {
    if (process.env.S2V_CLI_AUTO_UPDATE === '0') {
      return { checked: false, updated: false, reason: 'disabled (S2V_CLI_AUTO_UPDATE=0)' };
    }
    if (process.env.S2V_CLI?.trim()) {
      return { checked: false, updated: false, reason: 'external CLI pinned via S2V_CLI' };
    }
    if (!assetName()) {
      return { checked: false, updated: false, reason: `unsupported platform ${process.platform}/${process.arch}` };
    }
    const force = process.env.S2V_CLI_UPDATE_FORCE === '1';
    const { marker, exists: markerExists } = readMarker();
    const now = Date.now();
    const intervalH = Number(process.env.S2V_CLI_CHECK_INTERVAL_H ?? 6);
    const intervalMs = (Number.isFinite(intervalH) && intervalH > 0 ? intervalH : 6) * 3_600_000;
    if (!force && marker.checkedAt && now - marker.checkedAt < intervalMs) {
      return { checked: false, updated: false, reason: 'throttled' };
    }

    const desired = process.env.S2V_CLI_TAG?.trim() || 'latest';
    let release: { tag: string; url: string; apiUrl: string };
    try {
      release = await resolveRelease(desired, signal);
    } catch (err) {
      if (!signal?.aborted) writeMarker({ ...marker, checkedAt: now });
      throw err;
    }

    const haveExe = existsSync(join(cliDir(), EXE));
    // A marker with no tag means "installed out of band" (S2V_CLI_DIR copy,
    // manual drop-in): respect it instead of re-downloading every interval.
    const outOfBand = markerExists && !marker.tag && haveExe;
    if (!force && haveExe && (marker.tag === release.tag || outOfBand)) {
      writeMarker({ ...marker, checkedAt: now });
      return { checked: true, updated: false, from: release.tag, to: release.tag, reason: 'up to date' };
    }

    const from = marker.tag ?? (haveExe ? 'unknown' : 'missing');
    log(`cli-update: installing Source2Viewer-CLI ${release.tag} (had ${from})…`);
    await stageRelease(release.tag, release, log, signal);
    await swapStaged(signal);
    writeMarker({ tag: release.tag, checkedAt: now, updatedAt: now });
    log(`cli-update: Source2Viewer-CLI ${release.tag} ready in ${cliDir()}`);
    return { checked: true, updated: true, from, to: release.tag };
  } catch (err) {
    if (signal?.aborted) return { checked: false, updated: false, reason: 'aborted (server shutting down)' };
    log('cli-update failed:', err instanceof Error ? err.message : err);
    return { checked: false, updated: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// Manual run: `npx tsx src/cli/cliUpdate.ts` performs one check now. The
// basename guard keeps this from firing when the module is bundled into server.js.
const selfPath = fileURLToPath(import.meta.url);
if (
  basename(selfPath).startsWith('cliUpdate') &&
  process.argv[1] &&
  resolvePath(process.argv[1]) === selfPath
) {
  const result = await autoUpdateVendorCli({ log: (...a) => console.log('[cli-update]', ...a) });
  console.log(JSON.stringify(result));
}
