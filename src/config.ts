import { existsSync, readFileSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export interface VpkRoot {
  source: string;
  path: string;
}

/** Steam's install dir for Dota 2, relative to a Steam library root. */
const DOTA_REL = ['steamapps', 'common', 'dota 2 beta', 'game'];

/** Walks up from this module to find the package/bundle root. */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json')) || existsSync(join(dir, 'vendor'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Candidate Steam roots for a platform, most likely first. STEAM_PATH (if set)
 * always wins. Parameterised so tests can ask for another OS's list.
 */
export function steamRoots(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const roots: string[] = [];
  if (env.STEAM_PATH?.trim()) roots.push(env.STEAM_PATH.trim());
  if (platform === 'win32') {
    roots.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam', 'D:\\Steam', 'E:\\Steam');
  } else if (platform === 'darwin') {
    roots.push(join(home, 'Library', 'Application Support', 'Steam'));
  } else {
    roots.push(
      join(home, '.steam', 'steam'),
      join(home, '.local', 'share', 'Steam'),
      join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'), // Flatpak
      join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam'), // Snap
    );
  }
  return roots;
}

/** Where Dota usually lives when nothing is detected (reported in index_status errors). */
export function defaultGameDir(platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  const steam = steamRoots(platform, home, {})[0]!;
  return platform === 'win32' ? [steam, ...DOTA_REL].join('\\') : join(steam, ...DOTA_REL);
}

const hasDotaVpk = (game: string) => existsSync(join(game, 'dota', 'pak01_dir.vpk'));

/** Library paths listed in a Steam `libraryfolders.vdf` (on Windows `\` is escaped as `\\`). */
export function parseLibraryFolders(text: string): string[] {
  return [...text.matchAll(/"path"\s+"([^"]+)"/g)].map((m) => m[1]!.replace(/\\\\/g, '\\'));
}

/** Finds `<library>/steamapps/common/dota 2 beta/game` under any of the given Steam roots. */
export function detectDotaGameDir(roots: string[] = steamRoots()): string | null {
  for (const steam of roots) {
    const direct = join(steam, ...DOTA_REL);
    if (hasDotaVpk(direct)) return direct;
    let text: string;
    try {
      text = readFileSync(join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    } catch {
      continue;
    }
    for (const lib of parseLibraryFolders(text)) {
      const game = join(lib, ...DOTA_REL);
      if (hasDotaVpk(game)) return game;
    }
  }
  return null;
}

/**
 * Resolves the Dota `game` dir. DOTA_PATH may point at `.../dota 2 beta/game` or at
 * `.../dota 2 beta` itself; otherwise Steam is auto-detected.
 */
export function resolveGameDir(): string {
  const env = process.env.DOTA_PATH?.trim();
  if (env) {
    const game = join(env, 'game');
    return !hasDotaVpk(env) && hasDotaVpk(game) ? game : env;
  }
  return detectDotaGameDir() ?? defaultGameDir();
}

export function resolveVpkRoots(): VpkRoot[] {
  const game = resolveGameDir();
  const candidates: VpkRoot[] = [
    { source: 'dota', path: join(game, 'dota', 'pak01_dir.vpk') },
    { source: 'core', path: join(game, 'core', 'pak01_dir.vpk') },
  ];
  return candidates.filter((c) => existsSync(c.path));
}

/**
 * Resolves the Dota 2 console log. Order: CONSOLE_LOG env -> `<game>/dota/console.log`.
 * Returns the path even if it doesn't exist yet (the game creates it on launch).
 */
export function resolveConsoleLog(): string {
  const env = process.env.CONSOLE_LOG?.trim();
  if (env) return env;
  return join(resolveGameDir(), 'dota', 'console.log');
}

export interface LooseRoot {
  source: string;
  dir: string;
  via: string;
}

const NAMESPACE_DIRS = [
  'particles', 'models', 'materials', 'sounds', 'soundevents', 'maps',
  'scripts', 'panorama', 'resource', 'worldlayer_groups',
];

function isNamespaceRoot(dir: string): boolean {
  let count = 0;
  for (const n of NAMESPACE_DIRS) {
    try {
      if (statSync(join(dir, n)).isDirectory()) {
        if (++count >= 2) return true;
      }
    } catch {
      /* missing subdir */
    }
  }
  return count >= 1;
}

function addonNameFor(nsDir: string, projectDir: string): string {
  try {
    const real = realpathSync(nsDir).replace(/\\/g, '/');
    const m = real.match(/\/dota_addons\/([^/]+)\/?$/i);
    if (m) return m[1]!;
  } catch {
    /* not a symlink / unreadable */
  }
  return projectDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'addon';
}

/**
 * Locates the active addon's in-game namespace root (folder whose children are
 * particles/, models/, …). Handles the Steam install path, a project whose
 * `game/` is the namespace root (often a SYMLINK), the dir itself being a root,
 * and a real `game/dota_addons/<name>/` tree.
 */
function findAddonNamespace(start: string, via: string): LooseRoot | null {
  const norm = start.replace(/\\/g, '/');
  const m = norm.match(/^(.*\/game\/dota_addons\/([^/]+))(?:\/|$)/i);
  if (m && existsSync(m[1]!)) {
    return { source: `addon:${m[2]}`, dir: m[1]!.replace(/\//g, sep), via };
  }

  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (isNamespaceRoot(dir)) {
      return { source: `addon:${addonNameFor(dir, dir)}`, dir, via };
    }
    const g = join(dir, 'game');
    try {
      if (existsSync(g) && statSync(g).isDirectory() && isNamespaceRoot(g)) {
        return { source: `addon:${addonNameFor(g, dir)}`, dir: g, via };
      }
    } catch {
      /* ignore */
    }
    const ga = join(dir, 'game', 'dota_addons');
    try {
      const subs = readdirSync(ga).filter((n) => {
        try {
          return statSync(join(ga, n)).isDirectory();
        } catch {
          return false;
        }
      });
      if (subs.length > 0) {
        const projName = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
        const name = (projName && subs.includes(projName) ? projName : subs[0])!;
        return { source: `addon:${name}`, dir: join(ga, name), via };
      }
    } catch {
      /* no game/dota_addons here */
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * Resolves the SINGLE currently-open addon. Order: ADDON_PATH env ->
 * CLAUDE_PROJECT_DIR (the open project) -> cwd. Null if none resolves.
 */
export function resolveActiveAddon(): LooseRoot | null {
  const candidates: { p: string; via: string }[] = [];
  if (process.env.ADDON_PATH?.trim()) candidates.push({ p: process.env.ADDON_PATH.trim(), via: 'ADDON_PATH' });
  if (process.env.CLAUDE_PROJECT_DIR?.trim()) candidates.push({ p: process.env.CLAUDE_PROJECT_DIR.trim(), via: 'CLAUDE_PROJECT_DIR' });
  candidates.push({ p: process.cwd(), via: 'cwd' });

  for (const c of candidates) {
    try {
      if (!existsSync(c.p)) continue;
    } catch {
      continue;
    }
    const r = findAddonNamespace(c.p, c.via);
    if (r) return r;
  }
  return null;
}

export function resolveCliPath(): string | null {
  const exe = process.platform === 'win32' ? 'Source2Viewer-CLI.exe' : 'Source2Viewer-CLI';
  const root = packageRoot();
  const candidates = [
    process.env.S2V_CLI,
    join(root, 'vendor', 'Source2Viewer-CLI', exe),
    join(root, 'vendor', exe),
    // the maintainer's local VRF build (Windows only)
    process.platform === 'win32' ? 'C:\\Users\\Admin\\Documents\\ValveResourceFormat\\Source2Viewer-CLI.exe' : undefined,
  ];
  for (const c of candidates) {
    try {
      if (c && existsSync(c) && statSync(c).isFile()) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function firstDir(candidates: (string | undefined)[]): string | null {
  for (const c of candidates) {
    try {
      if (c && existsSync(c) && statSync(c).isDirectory()) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function resolveDotaDataDir(): string | null {
  const root = packageRoot();
  return firstDir([
    process.env.DOTA_DATA_PATH,
    join(root, 'vendor', 'dota-data'),
    process.platform === 'win32' ? 'C:\\Users\\Admin\\Documents\\dota\\dota-data\\files' : undefined,
  ]);
}

export function cacheTtlMs(): number {
  const v = Number(process.env.VPK_CACHE_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : 10 * 60 * 1000;
}
