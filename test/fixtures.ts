// Shared fixtures for the cross-platform tests: a synthetic Dota install (real VPK v2
// directory files written here, no Valve content), a console.log, and an addon project
// whose `game/` is linked into `game/dota_addons/<addon>` like the real projects are.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Builds a VPK v2 `_dir.vpk` with every file's data embedded after the tree. */
export function makeVpk(files: Record<string, Buffer>): Buffer {
  // ext -> dir -> [name, data]
  const tree = new Map<string, Map<string, [string, Buffer][]>>();
  for (const [path, data] of Object.entries(files)) {
    const slash = path.lastIndexOf('/');
    const dir = slash === -1 ? ' ' : path.slice(0, slash);
    const file = path.slice(slash + 1);
    const dot = file.lastIndexOf('.');
    const ext = dot === -1 ? ' ' : file.slice(dot + 1);
    const name = dot === -1 ? file : file.slice(0, dot);
    if (!tree.has(ext)) tree.set(ext, new Map());
    const dirs = tree.get(ext)!;
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir)!.push([name, data]);
  }
  const cstr = (s: string) => Buffer.from(s + '\0', 'latin1');
  const parts: Buffer[] = [];
  const blobs: Buffer[] = [];
  let dataOffset = 0;
  for (const [ext, dirs] of tree) {
    parts.push(cstr(ext));
    for (const [dir, names] of dirs) {
      parts.push(cstr(dir));
      for (const [name, data] of names) {
        parts.push(cstr(name));
        const e = Buffer.alloc(18);
        e.writeUInt32LE(0, 0); // crc (not validated by the reader)
        e.writeUInt16LE(0, 4); // preload bytes
        e.writeUInt16LE(0x7fff, 6); // archive index: embedded in _dir.vpk
        e.writeUInt32LE(dataOffset, 8);
        e.writeUInt32LE(data.length, 12);
        e.writeUInt16LE(0xffff, 16); // terminator
        parts.push(e);
        blobs.push(data);
        dataOffset += data.length;
      }
      parts.push(cstr(''));
    }
    parts.push(cstr(''));
  }
  parts.push(cstr(''));
  const treeBuf = Buffer.concat(parts);
  const header = Buffer.alloc(28);
  header.writeUInt32LE(0x55aa1234, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(treeBuf.length, 8);
  header.writeUInt32LE(dataOffset, 12); // file data section size
  return Buffer.concat([header, treeBuf, ...blobs]);
}

export const DOTA_FILES: Record<string, Buffer> = {
  'models/heroes/axe/axe.vmdl_c': Buffer.from('fake model'),
  'materials/models/heroes/axe/axe_body.vmat_c': Buffer.from('fake material'),
  'particles/units/heroes/hero_axe/axe_culling_blade.vpcf_c': Buffer.from('fake particle'),
  'scripts/npc/npc_heroes.txt': Buffer.from('"DOTAHeroes" {}'),
};
export const CORE_FILES: Record<string, Buffer> = {
  'materials/dev/error.vmat_c': Buffer.from('fake core material'),
};

export interface Fixture {
  root: string;
  steam: string;
  game: string;
  addonProject: string;
  consoleLog: string;
}

/**
 * Creates `<tmp>/Steam/steamapps/common/dota 2 beta/game/{dota,core}/pak01_dir.vpk`,
 * the addon `game/dota_addons/fixture_addon` with loose compiled files, a project dir
 * whose `game` links to it (junction on Windows, symlink elsewhere), and a console.log
 * with a BOM and CRLF line endings like the game writes on Windows.
 */
export function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dota2-mcp-test-'));
  const steam = join(root, 'Steam');
  const game = join(steam, 'steamapps', 'common', 'dota 2 beta', 'game');
  mkdirSync(join(game, 'dota'), { recursive: true });
  mkdirSync(join(game, 'core'), { recursive: true });
  writeFileSync(join(game, 'dota', 'pak01_dir.vpk'), makeVpk(DOTA_FILES));
  writeFileSync(join(game, 'core', 'pak01_dir.vpk'), makeVpk(CORE_FILES));

  const addon = join(game, 'dota_addons', 'fixture_addon');
  mkdirSync(join(addon, 'particles', 'custom'), { recursive: true });
  mkdirSync(join(addon, 'models', 'custom'), { recursive: true });
  writeFileSync(join(addon, 'particles', 'custom', 'my_effect.vpcf_c'), 'fake addon particle');
  writeFileSync(join(addon, 'models', 'custom', 'my_unit.vmdl_c'), 'fake addon model');

  const addonProject = join(root, 'project', 'fixture_addon');
  mkdirSync(addonProject, { recursive: true });
  symlinkSync(addon, join(addonProject, 'game'), process.platform === 'win32' ? 'junction' : 'dir');

  const consoleLog = join(game, 'dota', 'console.log');
  writeFileSync(
    consoleLog,
    '﻿' +
      [
        '10/01 12:00:00 [VScript] Script Error for Lua code:',
        '10/01 12:00:01 [Client] all good here',
        '10/01 12:00:02 [Server] Failed to load model models/missing.vmdl',
        '10/01 12:00:03 [Client] last line',
      ].join('\r\n') +
      '\r\n',
  );
  return { root, steam, game, addonProject, consoleLog };
}
