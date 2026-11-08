// M8 verification: live Workshop Tools & in-game UI / console / particle capture over the MCP wire.
// Requires the dota_dev.py dev stand up (server + tools client) and reachable at 127.0.0.1:8770.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const transport = new StdioClientTransport({ command: 'node', args: ['dist/server.js'] });
const client = new Client({ name: 'm8', version: '0.0.0' });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name);
const M8_TOOLS = [
  'tools_open',
  'window_list',
  'window_shot',
  'ui_tree',
  'ui_click',
  'ui_type',
  'console',
  'particle_shot',
];

const shotDir = path.join(os.tmpdir(), 'dota2-mcp-m8');
mkdirSync(shotDir, { recursive: true });

interface CallResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: Record<string, unknown>;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  return (await client.callTool({ name, arguments: args })) as CallResult;
}

function jsonOf(res: CallResult): any {
  const text = res.content.find((c) => c.type === 'text')?.text;
  try {
    return text ? JSON.parse(text) : res.structuredContent ?? null;
  } catch {
    return res.structuredContent ?? null;
  }
}

function savePng(name: string, res: CallResult): { saved: string | null; images: number } {
  const images = res.content.filter((c) => c.type === 'image');
  let saved: string | null = null;
  if (images.length > 0 && images[0]!.data) {
    const file = path.join(shotDir, `${name}.png`);
    writeFileSync(file, Buffer.from(images[0]!.data, 'base64'));
    saved = file;
  }
  return { saved, images: images.length };
}

const VPCF = 'particles/units/heroes/hero_lina/lina_spell_light_strike_array.vpcf';
const results: Record<string, any> = { hasM8Tools: M8_TOOLS.every((t) => tools.includes(t)) };
const checks: Record<string, boolean> = { toolsRegistered: results.hasM8Tools };

// 1. window_list — must see tool windows (pet) and/or the game window.
{
  const res = await call('window_list', { includeChildren: false });
  const j = jsonOf(res);
  results.window_list = { ok: j?.ok, count: j?.count, kinds: (j?.windows ?? []).map((w: any) => w.kind) };
  checks.window_list = j?.ok === true && (j?.count ?? 0) > 0 && !res.isError;
}

// 2. console — RCON 'status' on the dedicated server.
{
  const res = await call('console', { cmd: 'status', target: 'rcon' });
  const j = jsonOf(res);
  const text = JSON.stringify(j);
  results.console_rcon = { ok: j?.ok, preview: text.slice(0, 200) };
  checks.console_rcon = !res.isError && j?.ok !== false && text.length > 20;
}

// 3. console — server Lua via script_execute.
{
  const res = await call('console', {
    cmd: "print('[M8TEST] map=' .. tostring(GetMapName()))",
    target: 'lua',
  });
  const j = jsonOf(res);
  const text = JSON.stringify(j);
  results.console_lua = { ok: j?.ok, preview: text.slice(0, 300) };
  checks.console_lua = !res.isError && text.includes('M8TEST');
}

// 4. tools_open — open Lina's LSA particle in the Particle Editor.
{
  const res = await call('tools_open', { path: VPCF, waitMs: 6000, shotAfter: false });
  const j = jsonOf(res);
  results.tools_open = {
    ok: j?.ok,
    commandsSent: j?.commandsSent,
    window: j?.window ? { kind: j.window.kind, title: j.window.title, desktop: j.window.desktop } : null,
  };
  checks.tools_open = j?.ok === true && j?.window != null;
}

// 5. window_shot — background screenshot of the pet window.
{
  const res = await call('window_shot', { window: 'pet', maxDim: 800 });
  const j = jsonOf(res);
  const { saved, images } = savePng('window_shot_pet', res);
  results.window_shot = {
    ok: j?.ok,
    images,
    saved,
    imageWidth: j?.imageWidth,
    meanLuma: j?.meanLuma,
    nonBlackPct: j?.nonBlackPct,
  };
  checks.window_shot = j?.ok === true && images === 1 && (j?.nonBlackPct ?? 0) > 5;
}

// 6. ui_tree — read-only UIA inspection of the pet window.
{
  const res = await call('ui_tree', { window: 'pet', interactiveOnly: true, maxDepth: 7 });
  const j = jsonOf(res);
  const names = (j?.elements ?? []).slice(0, 12).map((e: any) => `${e.controlType}:${e.name}`);
  results.ui_tree = { ok: j?.ok, count: j?.count, sample: names };
  checks.ui_tree = j?.ok === true && (j?.count ?? 0) > 0;
}

// 7. ui_click — click 'Restart' in the CQParticlePreview toolbar (replays the effect).
{
  const res = await call('ui_click', {
    window: 'pet',
    name: 'Restart',
    groupClass: 'CQParticlePreview',
    waitMs: 400,
  });
  const j = jsonOf(res);
  results.ui_click = { ok: j?.ok, matchedBy: j?.target?.matchedBy, element: j?.target?.element?.name };
  checks.ui_click = j?.ok === true && j?.target?.matchedBy === 'uia_readonly';
}

// 8. ui_type — harmless Escape keypress to the pet window via PostMessageW.
{
  const res = await call('ui_type', { window: 'pet', key: 'Escape', waitMs: 200 });
  const j = jsonOf(res);
  results.ui_type = { ok: j?.ok, pressedKey: j?.pressedKey, targetHwnd: j?.targetHwnd };
  checks.ui_type = j?.ok === true && j?.pressedKey === 'Escape';
}

// 9. particle_shot (pet mode) — Restart + burst capture of the 3D viewport.
{
  const res = await call('particle_shot', { vpcf: VPCF, mode: 'pet', frames: 4, intervalMs: 200 });
  const j = jsonOf(res);
  const { saved, images } = savePng('particle_shot_pet', res);
  results.particle_shot_pet = {
    ok: j?.ok,
    mode: j?.mode,
    restartedPreview: j?.restartedPreview,
    images,
    saved,
    animated: j?.animated,
    frameDiffs: j?.frameDiffs,
  };
  checks.particle_shot_pet = j?.ok === true && j?.mode === 'pet' && images === 1;
}

// 10. particle_shot (ingame mode) — only when the game window is up and a match runs.
{
  let inGame = false;
  try {
    const wl: any = jsonOf(await call('window_list', {}));
    const hasGameWin = (wl?.windows ?? []).some((w: any) => w.kind === 'game');
    const rcon: any = jsonOf(await call('console', { cmd: 'status', target: 'rcon' }));
    inGame = hasGameWin && String(rcon?.text ?? '').includes('GAME_IN_PROGRESS');
  } catch {
    inGame = false;
  }
  if (inGame) {
    const res = await call('particle_shot', { vpcf: VPCF, mode: 'ingame', frames: 4 });
    const j = jsonOf(res);
    const { saved, images } = savePng('particle_shot_ingame', res);
    results.particle_shot_ingame = { ok: j?.ok, mode: j?.mode, images, saved, lua: JSON.stringify(j?.luaResult).slice(0, 200) };
    checks.particle_shot_ingame =
      j?.ok === true && images === 1 && JSON.stringify(j?.luaResult).includes('MCP_PARTICLE_SHOT');
  } else {
    results.particle_shot_ingame = 'skipped (no match in progress)';
  }
}

const pass = Object.entries(checks).every(([, v]) => v === true);
writeFileSync('m8result.json', JSON.stringify({ pass, checks, results }, null, 2));
console.log(JSON.stringify({ pass, checks }, null, 2));
console.log(pass ? 'M8_PASS' : 'M8_FAIL');
await client.close();
process.exit(pass ? 0 : 1);
