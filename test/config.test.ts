// Path resolution on every OS: Steam roots, libraryfolders.vdf, DOTA_PATH, the
// active addon through a linked `game/` folder, and the CLI executable name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  steamRoots, defaultGameDir, parseLibraryFolders, detectDotaGameDir, resolveGameDir,
  resolveActiveAddon, resolveCliPath, resolveDotaDataDir,
} from '../src/config.js';
import { makeFixture, makeVpk } from './fixtures.js';

test('steamRoots: per-OS defaults, STEAM_PATH first', () => {
  const mac = steamRoots('darwin', '/Users/me', {});
  assert.equal(mac[0], join('/Users/me', 'Library', 'Application Support', 'Steam'));
  const linux = steamRoots('linux', '/home/me', {});
  assert.ok(linux.includes(join('/home/me', '.steam', 'steam')));
  assert.ok(linux.includes(join('/home/me', '.local', 'share', 'Steam')));
  const win = steamRoots('win32', 'C:\\Users\\me', {});
  assert.equal(win[0], 'C:\\Program Files (x86)\\Steam');
  assert.equal(steamRoots('darwin', '/Users/me', { STEAM_PATH: '/Volumes/Games/Steam' })[0], '/Volumes/Games/Steam');
});

test('defaultGameDir: points into the platform Steam root', () => {
  assert.equal(defaultGameDir('win32'), 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\dota 2 beta\\game');
  assert.equal(
    defaultGameDir('darwin', '/Users/me'),
    join('/Users/me', 'Library', 'Application Support', 'Steam', 'steamapps', 'common', 'dota 2 beta', 'game'),
  );
});

test('parseLibraryFolders: Windows-escaped and POSIX paths', () => {
  const vdf = `"libraryfolders"
{
\t"0" { "path"\t\t"C:\\\\Program Files (x86)\\\\Steam" }
\t"1" { "path"\t\t"/Volumes/Games/SteamLibrary" }
}`;
  assert.deepEqual(parseLibraryFolders(vdf), ['C:\\Program Files (x86)\\Steam', '/Volumes/Games/SteamLibrary']);
});

test('detectDotaGameDir: direct install and a second library from libraryfolders.vdf', () => {
  const fx = makeFixture();
  assert.equal(detectDotaGameDir([join(fx.root, 'nope'), fx.steam]), fx.game);

  // Steam root without Dota whose libraryfolders.vdf points at another library.
  const other = mkdtempSync(join(tmpdir(), 'dota2-mcp-steam-'));
  const lib = join(other, 'Library2');
  const game2 = join(lib, 'steamapps', 'common', 'dota 2 beta', 'game');
  mkdirSync(join(game2, 'dota'), { recursive: true });
  writeFileSync(join(game2, 'dota', 'pak01_dir.vpk'), makeVpk({ 'a/b.txt': Buffer.from('x') }));
  mkdirSync(join(other, 'Steam', 'steamapps'), { recursive: true });
  const escaped = lib.replace(/\\/g, '\\\\');
  writeFileSync(join(other, 'Steam', 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { "1" { "path" "${escaped}" } }`);
  assert.equal(detectDotaGameDir([join(other, 'Steam')]), game2);
});

test('resolveGameDir: DOTA_PATH accepts ".../game" and ".../dota 2 beta"', () => {
  const fx = makeFixture();
  const saved = process.env.DOTA_PATH;
  try {
    process.env.DOTA_PATH = fx.game;
    assert.equal(resolveGameDir(), fx.game);
    process.env.DOTA_PATH = join(fx.game, '..');
    assert.equal(resolveGameDir(), join(fx.game, '..', 'game'));
  } finally {
    if (saved === undefined) delete process.env.DOTA_PATH;
    else process.env.DOTA_PATH = saved;
  }
});

test('resolveActiveAddon: project whose game/ is a junction/symlink into dota_addons', () => {
  const fx = makeFixture();
  const saved = process.env.ADDON_PATH;
  try {
    process.env.ADDON_PATH = fx.addonProject;
    const addon = resolveActiveAddon();
    assert.ok(addon, 'addon resolved');
    assert.equal(addon.source, 'addon:fixture_addon');
    assert.equal(addon.via, 'ADDON_PATH');
  } finally {
    if (saved === undefined) delete process.env.ADDON_PATH;
    else process.env.ADDON_PATH = saved;
  }
});

test('resolveCliPath / resolveDotaDataDir: platform executable name, vendored data', () => {
  const cli = resolveCliPath();
  if (cli) assert.match(cli, process.platform === 'win32' ? /Source2Viewer-CLI\.exe$/ : /Source2Viewer-CLI$/);
  else assert.notEqual(process.env.REQUIRE_CLI, '1', 'vendored Source2Viewer-CLI is required here');
  assert.ok(resolveDotaDataDir(), 'vendor/dota-data is committed and must resolve');
});
