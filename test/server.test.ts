// End-to-end over real MCP, no Dota install needed: spawns the server (from source via
// tsx, or MCP_SERVER_ENTRY = a built dist/server.js or a packaged release server.mjs)
// against the synthetic install, in stdio mode and in shared --http mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeFixture, type Fixture } from './fixtures.js';

const ENTRY = process.env.MCP_SERVER_ENTRY ? resolve(process.env.MCP_SERVER_ENTRY) : null;
const serverArgs = (extra: string[] = []) =>
  ENTRY ? [ENTRY, ...extra] : ['--import', 'tsx', resolve('src/server.ts'), ...extra];

function serverEnv(fx: Fixture, over: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.MCP_HTTP_PORT;
  delete env.CLAUDE_PROJECT_DIR;
  return {
    ...env,
    DOTA_PATH: fx.game,
    ADDON_PATH: fx.addonProject,
    CONSOLE_LOG: fx.consoleLog,
    LOG_FILE: join(fx.root, 'logs', 'dota2-mcp.log'),
    ADDON_WATCH: '0',
    ...over,
  };
}

const text = (r: unknown) => JSON.stringify(r);

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  return (r.structuredContent ?? r.content) as Record<string, any>;
}

test('stdio: index, search, API/KV/localization, console log, activity log', { timeout: 180_000 }, async () => {
  const fx = makeFixture();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: serverArgs(),
    env: serverEnv(fx),
    cwd: resolve('.'),
    stderr: 'inherit',
  });
  const client = new Client({ name: 'xplat-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ['index_status', 'find_assets', 'api_search', 'hero_kv', 'localize', 'console_tail', 'server_log']) {
      assert.ok(tools.includes(t), `tool ${t}`);
    }

    const st = await call(client, 'index_status');
    assert.equal(st.ready, true, text(st));
    assert.equal(st.gameDir, fx.game);
    assert.deepEqual(st.archives.map((a: any) => a.source).sort(), ['core', 'dota']);
    assert.equal(st.addons[0]?.source, 'addon:fixture_addon', text(st.addons));
    if (process.env.REQUIRE_CLI === '1') {
      // proves the vendored decompiler binary actually runs on this OS/arch
      assert.equal(st.cli.available, true, text(st.cli));
      assert.ok(st.cli.version, `CLI --version answered: ${text(st.cli)}`);
    }

    assert.match(text(await call(client, 'find_assets', { query: 'axe' })), /models\/heroes\/axe\/axe\.vmdl_c/);
    assert.match(text(await call(client, 'find_assets', { query: 'my_effect' })), /particles\/custom\/my_effect\.vpcf_c/);
    assert.match(text(await call(client, 'resolve_asset', { name: 'models/heroes/axe/ax.vmdl_c' })), /axe\.vmdl_c/);
    assert.match(text(await call(client, 'list_dir', { prefix: 'models/heroes' })), /axe/);
    assert.match(text(await call(client, 'stat_asset', { path: 'models\\heroes\\axe\\axe.vmdl_c' })), /axe\.vmdl_c/);

    assert.match(text(await call(client, 'api_search', { query: 'GetHealth' })), /GetHealth/);
    assert.match(text(await call(client, 'hero_kv', { name: 'npc_dota_hero_axe' })), /npc_dota_hero_axe/);
    assert.match(text(await call(client, 'localize', { key: 'npc_dota_hero_axe', lang: 'russian' })), /npc_dota_hero_axe/i);

    const tail = await call(client, 'console_tail', { lines: 2 });
    assert.equal(tail.exists, true);
    assert.deepEqual(tail.lines, ['10/01 12:00:02 [Server] Failed to load model models/missing.vmdl', '10/01 12:00:03 [Client] last line']);
    const errs = await call(client, 'console_errors', { since: { offset: 0, size: 0, mtimeMs: 0, sig: '' } });
    assert.ok(errs.totalMatched >= 2, text(errs));
    assert.ok(errs.entries.every((e: any) => !String(e.message).includes('\r')), 'no CR left from CRLF');

    const slog = await call(client, 'server_log', { limit: 5 });
    assert.match(text(slog), /console_errors|console_tail/);
  } finally {
    await client.close();
  }
});

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

test('http: /health, a session over streamable HTTP, missing console.log', { timeout: 180_000 }, async () => {
  const fx = makeFixture();
  const port = await freePort();
  const child = spawn(process.execPath, serverArgs(['--http', String(port)]), {
    env: serverEnv(fx, { CONSOLE_LOG: join(fx.root, 'no-such', 'console.log') }),
    cwd: resolve('.'),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    let health: any = null;
    for (let i = 0; i < 120 && !health; i++) {
      try {
        const r = await fetch(`${base}/health`);
        if (r.ok) health = await r.json();
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    assert.ok(health, `server answered /health. stderr:\n${stderr}`);
    assert.equal(health.ready, true);

    const client = new Client({ name: 'xplat-http', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const st = await call(client, 'index_status');
      assert.equal(st.ready, true);
      const tail = await call(client, 'console_tail', { lines: 5 });
      assert.equal(tail.exists, false);
      assert.match(tail.note, /-condebug/);
    } finally {
      await client.close();
    }
  } finally {
    child.kill();
  }
});
