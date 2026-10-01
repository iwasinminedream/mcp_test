// The own VPK v2 reader against a VPK written by the test (no Valve files needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VpkArchive } from '../src/vpk/reader.js';
import { makeVpk, DOTA_FILES } from './fixtures.js';

test('VpkArchive: parses the tree and reads embedded file data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dota2-mcp-vpk-'));
  const path = join(dir, 'pak01_dir.vpk');
  writeFileSync(path, makeVpk(DOTA_FILES));

  const vpk = new VpkArchive(path, 'dota');
  vpk.load();
  assert.equal(vpk.entries.size, Object.keys(DOTA_FILES).length);
  for (const [p, data] of Object.entries(DOTA_FILES)) {
    const e = vpk.entries.get(p);
    assert.ok(e, `entry ${p}`);
    assert.deepEqual(vpk.readFile(e), data);
    assert.deepEqual(vpk.readRange(e, 1, 3), data.subarray(1, 4));
  }
  const axe = vpk.entries.get('models/heroes/axe/axe.vmdl_c')!;
  assert.equal(axe.dir, 'models/heroes/axe');
  assert.equal(axe.ext, 'vmdl_c');
  assert.equal(vpk.archivePathFor(axe), path);
});

test('VpkArchive: rejects a non-VPK file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dota2-mcp-vpk-'));
  const path = join(dir, 'broken_dir.vpk');
  writeFileSync(path, Buffer.alloc(64));
  assert.throws(() => new VpkArchive(path, 'x').load(), /Bad VPK signature/);
});
