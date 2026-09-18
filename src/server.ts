import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildIndex, type BuiltIndex } from './indexer.js';
import { VALID_KINDS } from './kinds.js';
import { sweepTempRoot } from './cache.js';
import { cliAvailable, cliVersion } from './cli/decompiler.js';
import { resolveCliPath } from './config.js';
import { modelInfo } from './introspect/model.js';
import { particleInfo } from './introspect/particle.js';
import { materialInfo } from './introspect/material.js';
import { decompileAsset } from './introspect/decompile.js';
import { DepGraph, type GraphStatus } from './graph/depGraph.js';
import { validateAttachment, genAttachSnippet, PATTACH, type PattachName } from './introspect/attach.js';
import { previewTexture, exportModel } from './cli/convert.js';
import { ApiIndex } from './api/apiIndex.js';
import type { ApiDomain, ApiKind } from './api/apiData.js';
import { GameData } from './api/gameData.js';
import { consoleMark, consoleErrors, consoleTail, type ConsoleCursor, type MarkResult } from './console/consoleLog.js';
import { startAddonWatcher, type AddonWatcher } from './loose/watcher.js';
import { logToolCall, writeLog, readLog, logFilePath } from './log.js';

// IMPORTANT: stdout carries the JSON-RPC stream. All logging must go to stderr.
const log = (...a: unknown[]) => console.error('[dota2-mcp]', ...a);

sweepTempRoot();
let built: BuiltIndex = buildIndex(log);

function ensureReady(): string | null {
  return built.status.ready ? null : built.status.error ?? 'Index not ready.';
}

function ok(data: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function fail(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

const graph = new DepGraph();
const api = new ApiIndex();
const gameData = new GameData();
const API_DOMAINS = ['lua', 'panorama-js', 'panorama-css', 'panorama-enum', 'panorama-event', 'event', 'engine-enum', 'modifier'] as const;
const API_KINDS = ['class', 'function', 'method', 'constant', 'enum', 'css-property', 'event', 'modifier-property', 'modifier'] as const;

// Auto-mark the console at startup as a fallback "moment", so console_errors
// without an explicit cursor reports only what was logged after the server began.
const startupCursor: MarkResult = consoleMark();

/**
 * Builds the dependency graph if not already built. Idempotent and safe to call
 * from the background warmup and from a tool handler concurrently — the build is
 * synchronous, so the first caller wins and the rest see `graph.built`.
 */
function ensureGraph(): GraphStatus {
  if (!graph.built) {
    log('building dependency graph (then cached)…');
    graph.build(built.index, { log });
  }
  return graph.status;
}

/**
 * Warms up the lazy/expensive parts in the background, so the next real request
 * is fast. The base index + API data are already loaded eagerly at startup; the
 * only on-demand build is the dependency graph (loads instantly from disk cache
 * when the Dota version is unchanged, else builds once). Pass force=true after a
 * reindex to rebuild the graph against the new index regardless of cache.
 */
function warmup(force = false): void {
  setTimeout(() => {
    try {
      const t0 = Date.now();
      if (force) graph.build(built.index, { force: true, log });
      else ensureGraph();
      log(`warmup done: graph ready (${graph.status.edges} edges) in ${Date.now() - t0}ms`);
    } catch (err) {
      log('warmup failed (graph will build on first use):', err instanceof Error ? err.message : err);
    }
  }, 0).unref();
}

// Live watcher for the active addon: keeps index + graph in sync as assets are
// recompiled (compiled assets only; scripts/ ignored; incremental + addon-scoped).
let watcher: AddonWatcher | null = null;
function startWatcher(): void {
  watcher?.close();
  watcher = null;
  if (process.env.ADDON_WATCH === '0') return; // opt-out
  if (!built.addonDir) return; // no active addon → nothing to watch
  watcher = startAddonWatcher({
    addonDir: built.addonDir,
    index: built.index,
    graph,
    refinalize: () => built.index.finalizeAsync(),
    log,
  });
}

const server = new McpServer({ name: 'dota2-mcp', version: '0.1.0' });

// Wrap registerTool so EVERY tool call is timed, logged to the persistent JSONL
// activity log, and protected: a thrown handler error is caught, logged, and
// returned to the client as a clean isError result instead of crashing the call.
// (Covers all tools below without touching each registration.)
type RegisterToolFn = (name: string, config: unknown, handler: (...args: unknown[]) => unknown) => unknown;
const _registerTool = server.registerTool.bind(server) as unknown as RegisterToolFn;
(server as unknown as { registerTool: RegisterToolFn }).registerTool = (
  name: string,
  config: unknown,
  handler: (...args: unknown[]) => unknown,
) => {
  const wrapped = async (...args: unknown[]) => {
    const t0 = Date.now();
    const toolArgs = args[0];
    try {
      const res = (await handler(...args)) as { isError?: boolean } | undefined;
      logToolCall(name, toolArgs, { ms: Date.now() - t0, isError: res?.isError === true });
      return res;
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      logToolCall(name, toolArgs, { ms: Date.now() - t0, isError: true, error: message });
      log(`tool "${name}" threw:`, message);
      return {
        content: [{ type: 'text' as const, text: `Internal error in "${name}": ${message}` }],
        isError: true,
      };
    }
  };
  return _registerTool(name, config, wrapped);
};

server.registerTool(
  'find_assets',
  {
    title: 'Find assets',
    description:
      'Search Dota 2 VPK asset paths by substring or glob (use * wildcards). ' +
      'Optionally filter by kind. Returns paginated matching paths.',
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe('Substring, or a glob with * wildcards, matched against the full asset path (case-insensitive).'),
      kind: z
        .string()
        .optional()
        .describe(`Filter by asset kind. One of: ${VALID_KINDS.join(', ')} (or a raw extension like vmdl_c).`),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0),
    }),
  },
  async ({ query, kind, limit, offset }) => {
    const notReady = ensureReady();
    if (notReady) return fail(notReady);
    return ok(built.index.find(query, { kind, limit, offset }) as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  'resolve_asset',
  {
    title: 'Resolve asset name (fuzzy)',
    description:
      'Typo-tolerant lookup: given an approximate or misspelled asset name/path, ' +
      'returns the closest real asset paths with a match score. Use this to fix wrong names before referencing them.',
    inputSchema: z.object({
      name: z.string().min(1).describe('Approximate asset name or path (may contain typos).'),
      kind: z.string().optional().describe(`Optional kind filter (${VALID_KINDS.join(', ')}, or a raw extension).`),
      limit: z.number().int().min(1).max(50).default(10),
    }),
  },
  async ({ name, kind, limit }) => {
    const notReady = ensureReady();
    if (notReady) return fail(notReady);
    return ok(built.index.resolve(name, { kind, limit }) as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  'list_dir',
  {
    title: 'List asset directory',
    description:
      'List the immediate sub-directories and files under a virtual VPK path prefix ' +
      '(e.g. "particles/units/heroes"). Pass an empty prefix to see top-level folders.',
    inputSchema: z.object({
      prefix: z.string().default('').describe('Directory prefix, forward slashes. Empty = archive root.'),
    }),
  },
  async ({ prefix }) => {
    const notReady = ensureReady();
    if (notReady) return fail(notReady);
    return ok(built.index.listDir(prefix) as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  'stat_asset',
  {
    title: 'Stat asset',
    description:
      'Return metadata for an exact asset path (size, archive, crc32, source package, kind). ' +
      'If the path does not exist, returns fuzzy suggestions.',
    inputSchema: z.object({
      path: z.string().min(1).describe('Exact asset path, e.g. "models/heroes/axe/axe.vmdl_c".'),
    }),
  },
  async ({ path }) => {
    const notReady = ensureReady();
    if (notReady) return fail(notReady);
    return ok(built.index.stat(path) as unknown as Record<string, unknown>);
  },
);

// ---- M2: introspection (decompile / attachments / references) ----

server.registerTool(
  'model_info',
  {
    title: 'Model info (attachments & references)',
    description:
      'Inspect a Source 2 model (.vmdl_c): list its attachment-point names (attach_*, what you bind ' +
      'particles to) and the materials/sub-models it references (each flagged as existing or missing). ' +
      'Attachment names work without the CLI; references use the model RERL block when the CLI is present.',
    inputSchema: z.object({
      path: z.string().min(1).describe('Model path, e.g. "models/heroes/axe/axe.vmdl_c".'),
    }),
  },
  async ({ path }) => {
    const notReady = ensureReady();
    if (notReady) return fail(notReady);
    return ok((await modelInfo(built.index, path)) as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  'particle_info',
  {
    title: 'Particle info (references & structure)',
    description:
      'Inspect a Source 2 particle system (.vpcf_c): its referenced materials/textures and child ' +
      '.vpcf systems (flagged existing/missing), plus structure (function classes, max particles, ' +
      'control points incl. children, and control-point→attachment bindings from the preview ' +
      'config). Requires Source2Viewer-CLI for full structure; falls back to a strings scan.',
    inputSchema: z.object({
      path: z.string().min(1).describe('Particle path, e.g. "particles/units/heroes/hero_axe/axe_culling_blade.vpcf_c".'),
    }),
  },
  async ({ path }) => {
    const notReady = ensureReady();
    if (notReady) return fail(notReady);
    return ok((await particleInfo(built.index, path)) as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  'material_info',
  {
    title: 'Material info (shader & textures)',
    description:
      'Inspect a Source 2 material (.vmat_c): its shader name and referenced textures/assets ' +
      '(flagged existing/missing). Requires Source2Viewer-CLI; falls back to a strings scan.',
    inputSchema: z.object({
      path: z.string().min(1).describe('Material path, e.g. "materials/models/heroes/axe/axe_body.vmat_c".'),
    }),
  },
  async ({ path }) => {
    const notReady = ensureReady();
    if (notReady) return fail(notReady);
    return ok((await materialInfo(built.index, path)) as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  'decompile',
  {
    title: 'Decompile asset to KV3 text',
    description:
      'Decompile any supported compiled resource (_c) to its KV3 source text via Source2Viewer-CLI, ' +
      'with char-offset pagination. Decompiled artifacts are written to an ephemeral temp dir and ' +
      'deleted immediately after reading.',
    inputSchema: z.object({
      path: z.string().min(1).describe('Asset path including the _c extension.'),
      offset: z.number().int().min(0).default(0).describe('Character offset to start from (for paging large output).'),
      limit: z.number().int().min(1).max(60000).default(60000).describe('Max characters to return.'),
    }),
  },
  async ({ path, offset, limit }) => {
    const notReady = ensureReady();
    if (notReady) return fail(notReady);
    return ok((await decompileAsset(built.index, path, offset, limit)) as unknown as Record<string, unknown>);
  },
);

// ---- M3: dependency graph + attachment validation / codegen ----

server.registerTool(
  'refs_from',
  {
    title: 'References from (outgoing deps)',
    description:
      'List the assets that a given asset references (materials, textures, child particles, sub-models). ' +
      'Builds the dependency graph on first use (then cached).',
    inputSchema: z.object({
      path: z.string().min(1).describe('Asset path (with or without _c).'),
    }),
  },
  async ({ path }) => {
    const notReady = ensureReady();
    if (notReady) return fail(notReady);
    ensureGraph();
    const key = built.index.has(path) ? path : built.index.has(path + '_c') ? path + '_c' : path;
    const refs = graph.refsFrom(key);
    return ok({ path: key, count: refs.length, references: refs });
  },
);

server.registerTool(
  'refs_to',
  {
    title: 'References to (reverse deps)',
    description:
      'List the assets that reference a given asset — e.g. which models/particles use this material or texture. ' +
      'Builds the dependency graph on first use (then cached). Great for "what breaks if I rename X".',
    inputSchema: z.object({
      path: z.string().min(1).describe('Asset path (with or without _c).'),
      limit: z.number().int().min(1).max(2000).default(200),
    }),
  },
  async ({ path, limit }) => {
    const notReady = ensureReady();
    if (notReady) return fail(notReady);
    ensureGraph();
    const key = built.index.has(path) ? path : built.index.has(path + '_c') ? path + '_c' : path;
    const all = graph.refsTo(key);
    return ok({ path: key, total: all.length, count: Math.min(all.length, limit), referrers: all.slice(0, limit) });
  },
);

server.registerTool(
  'build_graph',
  {
    title: 'Build dependency graph',
    description:
      'Force a (re)build of the asset dependency graph by scanning the leading bytes of every referrer file. ' +
      'Normally built lazily on first refs_from/refs_to; use this to refresh after a Dota update.',
    inputSchema: z.object({
      force: z.boolean().default(true).describe('Rebuild even if a valid cache exists.'),
    }),
  },
  async ({ force }) => {
    const notReady = ensureReady();
    if (notReady) return fail(notReady);
    const status = graph.build(built.index, { force, log });
    return ok(status as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  'validate_attachment',
  {
    title: 'Validate particle attachment',
    description:
      'Preflight check before binding a particle to a model: verifies the model exists, the particle exists ' +
      '(if given), and the attachment name actually exists on the model — returning the model\'s real ' +
      'attachment list and fuzzy suggestions on any miss.',
    inputSchema: z.object({
      model: z.string().min(1).describe('Model path, e.g. "models/heroes/axe/axe.vmdl_c".'),
      attachment: z.string().min(1).describe('Attachment name, e.g. "attach_hitloc".'),
      particle: z.string().optional().describe('Optional particle path to also verify.'),
    }),
  },
  async ({ model, attachment, particle }) => {
    const notReady = ensureReady();
    if (notReady) return fail(notReady);
    return ok((await validateAttachment(built.index, model, attachment, particle)) as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  'gen_attach_snippet',
  {
    title: 'Generate particle-attach Lua',
    description:
      'Generate a correct Lua snippet that creates a particle and binds a control point to a model attachment, ' +
      'using validated asset paths and attachment names. Validates first; warns (but still emits) on any issue.',
    inputSchema: z.object({
      model: z.string().min(1).describe('Model path the attachment belongs to.'),
      attachment: z.string().min(1).describe('Attachment name, e.g. "attach_attack1".'),
      particle: z.string().min(1).describe('Particle path, e.g. "particles/.../foo.vpcf".'),
      controlPoint: z.number().int().min(0).max(63).default(0).describe('Control-point index to bind.'),
      attachType: z
        .enum(Object.keys(PATTACH) as [PattachName, ...PattachName[]])
        .default('PATTACH_POINT_FOLLOW')
        .describe('ParticleAttachment_t; the attachment name only applies to PATTACH_POINT[_FOLLOW].'),
      entityVar: z.string().default('hEntity').describe('Lua variable name for the target entity.'),
    }),
  },
  async ({ model, attachment, particle, controlPoint, attachType, entityVar }) => {
    const notReady = ensureReady();
    if (notReady) return fail(notReady);
    return ok((await genAttachSnippet(built.index, {
      model, attachment, particle, controlPoint, attachType, entityVar,
    })) as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  'index_status',
  {
    title: 'Index status',
    description: 'Report indexer status: game directory, loaded packages, addon, asset count, valid kinds, CLI availability, graph state, API availability, game KV/localization data, console.',
    inputSchema: z.object({}),
  },
  async () => {
    const cli = resolveCliPath();
    return ok({
      ...built.status,
      validKinds: VALID_KINDS,
      cli: { available: cliAvailable(), path: cli, version: await cliVersion() },
      graph: { built: graph.built, ...(graph.built ? graph.status : {}) },
      api: api.status,
      gameData: gameData.status,
      console: { logPath: startupCursor.path, exists: startupCursor.exists, startupOffset: startupCursor.offset },
      activityLog: { path: logFilePath(), enabled: process.env.LOG !== '0' },
      watcher: { active: watcher !== null, ...(watcher ? watcher.stats : {}) },
    } as unknown as Record<string, unknown>);
  },
);

// ---- M6: Dota 2 console log (errors since a moment, via byte cursor) ----

server.registerTool(
  'console_mark',
  {
    title: 'Mark console position',
    description:
      'Capture a cursor at the current end of the Dota 2 console log — "the moment". Call this at the start ' +
      'of a task, then pass the returned cursor to console_errors as `since` to get only what the game logs ' +
      'afterwards (the log grows to tens of MB, so this byte cursor avoids rereading it).',
    inputSchema: z.object({}),
  },
  async () => ok(consoleMark() as unknown as Record<string, unknown>),
);

server.registerTool(
  'console_errors',
  {
    title: 'Console errors since a moment',
    description:
      'Read NEW console lines since a cursor and return classified errors/warnings. Multi-line Lua tracebacks ' +
      'are stitched together; identical messages are deduped with a count; log rotation is detected. If `since` ' +
      'is omitted, uses the cursor captured when the server started.',
    inputSchema: z.object({
      since: z
        .object({
          offset: z.number().int().min(0),
          size: z.number().int().min(0),
          mtimeMs: z.number(),
          sig: z.string(),
        })
        .optional()
        .describe('Cursor from console_mark or a previous console_errors.newCursor. Omit = server-start moment.'),
      level: z.enum(['error', 'warning', 'info']).default('error').describe('Minimum severity to include.'),
      dedupe: z.boolean().default(true).describe('Collapse identical messages with a count.'),
      limit: z.number().int().min(1).max(1000).default(100),
    }),
  },
  async ({ since, level, dedupe, limit }) => {
    const cursor = (since as ConsoleCursor | undefined) ?? startupCursor;
    return ok(consoleErrors({ since: cursor, level, dedupe, limit }) as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  'console_tail',
  {
    title: 'Tail console log',
    description: 'Return the last N raw lines of the Dota 2 console log (no filtering).',
    inputSchema: z.object({
      lines: z.number().int().min(1).max(2000).default(50),
    }),
  },
  async ({ lines }) => ok(consoleTail(lines) as unknown as Record<string, unknown>),
);

server.registerTool(
  'server_log',
  {
    title: 'Read server activity log',
    description:
      'Read the persistent activity log (newest first): every tool call with its name, duration, and whether it ' +
      'errored. Use this to see if the server hit an error or returned a bad/empty result during a session. ' +
      'Filter by tool name, level, or errors-only. The log file path is returned so you can inspect it directly.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(1000).default(50),
      errorsOnly: z.boolean().default(false).describe('Only entries that threw or returned isError.'),
      tool: z.string().optional().describe('Substring filter on tool name.'),
      level: z.enum(['info', 'error']).optional(),
    }),
  },
  async ({ limit, errorsOnly, tool, level }) =>
    ok(readLog({ limit, errorsOnly, tool, level }) as unknown as Record<string, unknown>),
);

server.registerTool(
  'reindex',
  {
    title: 'Rebuild index',
    description:
      'Re-read the VPK packages + active addon and rebuild the in-memory index (use after a Dota update or ' +
      'after recompiling addon assets). Also rebuilds the dependency graph in the background against the new index.',
    inputSchema: z.object({}),
  },
  async () => {
    built = buildIndex(log);
    gameData.reset(); // re-read game KV/localization if the data was re-vendored
    // The graph holds edges from the OLD index; force a fresh background rebuild
    // so refs_from/refs_to reflect the new assets (cache is keyed by index
    // fingerprint, but `graph.built` is already true, so we must force it).
    warmup(true);
    startWatcher(); // re-attach the live watcher to the rebuilt addon source
    return ok({ ...built.status, validKinds: VALID_KINDS } as unknown as Record<string, unknown>);
  },
);


// ---- M4: conversion (texture preview / model export) ----

server.registerTool(
  'preview_texture',
  {
    title: 'Preview texture (PNG)',
    description:
      'Decompile a Source 2 texture (.vtex_c) to a PNG and return it as an inline image, downscaled to ' +
      'fit maxDim. The temp PNG is deleted right after reading. Requires Source2Viewer-CLI.',
    inputSchema: z.object({
      path: z.string().min(1).describe('Texture path, e.g. "materials/.../foo_color.vtex_c".'),
      maxDim: z.number().int().min(32).max(1024).default(512).describe('Max width/height of the returned preview.'),
    }),
  },
  async ({ path, maxDim }) => {
    const notReady = ensureReady();
    if (notReady) return fail(notReady);
    const read = built.index.read(path);
    if (!read) {
      const sug = built.index.resolve(path, { kind: 'texture', limit: 5 }).results;
      return ok({ ok: false, error: `No asset at "${path}".`, suggestions: sug } as unknown as Record<string, unknown>);
    }
    const r = await previewTexture(read.bytes, read.path, maxDim);
    if (!r.ok || !r.pngBase64) {
      return ok({ ok: false, error: r.error ?? 'preview failed', note: r.note } as unknown as Record<string, unknown>);
    }
    const { pngBase64, ...meta } = r;
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ path: read.path, source: read.source, ...meta }, null, 2) },
        { type: 'image' as const, data: pngBase64, mimeType: 'image/png' },
      ],
      structuredContent: { path: read.path, source: read.source, ...meta },
    };
  },
);

server.registerTool(
  'export_model',
  {
    title: 'Export model (glTF/GLB)',
    description:
      'Decompile a Source 2 model (.vmdl_c) to glTF or GLB on disk and return the output path + file list. ' +
      'Unlike previews, the exported files PERSIST (override dir via EXPORT_DIR). Requires Source2Viewer-CLI.',
    inputSchema: z.object({
      path: z.string().min(1).describe('Model path, e.g. "models/heroes/axe/axe.vmdl_c".'),
      format: z.enum(['glb', 'gltf']).default('glb').describe('glb = single binary file; gltf = JSON + external buffers/textures.'),
      animations: z.boolean().default(false).describe('Include skeletal animations.'),
      materials: z.boolean().default(true).describe('Export materials/textures.'),
    }),
  },
  async ({ path, format, animations, materials }) => {
    const notReady = ensureReady();
    if (notReady) return fail(notReady);
    const read = built.index.read(path);
    if (!read) {
      const sug = built.index.resolve(path, { kind: 'model', limit: 5 }).results;
      return ok({ ok: false, error: `No asset at "${path}".`, suggestions: sug } as unknown as Record<string, unknown>);
    }
    const r = await exportModel(read.bytes, read.path, { format, animations, materials });
    return ok({ path: read.path, source: read.source, ...r } as unknown as Record<string, unknown>);
  },
);

// ---- M5: Dota 2 API knowledge ----

server.registerTool(
  'api_search',
  {
    title: 'Search Dota 2 API',
    description:
      'Search the Dota 2 modding API (Lua/vscripts, Panorama JS, Panorama CSS, enums, events, modifiers) by name. ' +
      'Returns matching symbols with their kind, owning class, and signature — so you use correct names/types.',
    inputSchema: z.object({
      query: z.string().min(1).describe('Name or fragment, e.g. "CreateUnit", "SetParticleControlEnt", "PATTACH".'),
      domain: z.enum(API_DOMAINS).optional(),
      kind: z.enum(API_KINDS).optional(),
      limit: z.number().int().min(1).max(100).default(25),
    }),
  },
  async ({ query, domain, kind, limit }) => {
    if (!api.loaded) return ok({ error: api.status.error, status: api.status } as unknown as Record<string, unknown>);
    return ok(api.search(query, { domain: domain as ApiDomain, kind: kind as ApiKind, limit }) as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  'api_get',
  {
    title: 'Get Dota 2 API symbol',
    description:
      'Get full detail for an API symbol by exact name: function/method signature (args + types + returns), ' +
      'constant value, enum members, event fields, etc. Methods accept "Class:method" or the bare method name. ' +
      'On a miss, returns fuzzy suggestions.',
    inputSchema: z.object({
      name: z.string().min(1).describe('Symbol name, e.g. "CDOTA_BaseNPC:GetHealth", "PATTACH_POINT_FOLLOW".'),
      domain: z.enum(API_DOMAINS).optional(),
      class: z.string().optional().describe('Disambiguate a method by its owning class.'),
    }),
  },
  async ({ name, domain, class: className }) => {
    if (!api.loaded) return ok({ error: api.status.error } as unknown as Record<string, unknown>);
    return ok(api.get(name, { domain: domain as ApiDomain, className }) as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  'api_class',
  {
    title: 'Get Lua API class',
    description:
      'Get a Lua API class with its own methods AND methods inherited up the extend chain (e.g. CDOTA_BaseNPC ' +
      'inherits from CBaseEntity). Use to discover everything callable on an entity type.',
    inputSchema: z.object({
      name: z.string().min(1).describe('Class name, e.g. "CDOTA_BaseNPC_Hero".'),
    }),
  },
  async ({ name }) => {
    if (!api.loaded) return ok({ error: api.status.error } as unknown as Record<string, unknown>);
    return ok(api.classInfo(name) as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  'css_prop',
  {
    title: 'Panorama CSS property declaration',
    description:
      'Look up a Panorama CSS property declaration (description + examples) by exact name, e.g. "flow-children", ' +
      '"background-blur", "wash-color". On a miss, returns fuzzy suggestions. Use this to confirm a CSS property ' +
      'actually exists in Panorama before writing it.',
    inputSchema: z.object({
      name: z.string().min(1).describe('CSS property name, e.g. "flow-children".'),
    }),
  },
  async ({ name }) => {
    if (!api.loaded) return ok({ error: api.status.error } as unknown as Record<string, unknown>);
    return ok(api.cssProp(name) as unknown as Record<string, unknown>);
  },
);

// ---- Game KV data (abilities / heroes / units / localization) ----

server.registerTool(
  'ability_kv',
  {
    title: 'Ability KeyValues',
    description:
      'Get the REAL KeyValues for an ability from npc_abilities (abilities.json): AbilityBehavior, cast range/point, ' +
      'cooldown, mana cost, AbilityValues/special values, etc. — the actual in-game numbers, not guesses. Also ' +
      'returns the owning hero and localized name/description. Fuzzy suggestions on a miss.',
    inputSchema: z.object({
      name: z.string().min(1).describe('Ability key, e.g. "abaddon_death_coil" or "item_blink".'),
      resolveBase: z.boolean().default(false).describe('Merge the implicit "ability_base" template under the entry.'),
    }),
  },
  async ({ name, resolveBase }) => {
    const s = gameData.status;
    if (!s.loaded) return ok({ error: s.error } as unknown as Record<string, unknown>);
    return ok(gameData.getEntry('ability', name, { resolveBase }) as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  'hero_kv',
  {
    title: 'Hero KeyValues',
    description:
      'Get the REAL KeyValues for a hero from npc_heroes (heroes.json): Model, attributes, base damage/armor, ' +
      'attack range, movement speed, the Ability1..N list, etc. Returns the declared abilities and localized name. ' +
      'Fuzzy suggestions on a miss.',
    inputSchema: z.object({
      name: z.string().min(1).describe('Hero unit name, e.g. "npc_dota_hero_axe".'),
      resolveBase: z.boolean().default(false).describe('Merge the implicit "npc_dota_hero_base" template under the entry.'),
    }),
  },
  async ({ name, resolveBase }) => {
    const s = gameData.status;
    if (!s.loaded) return ok({ error: s.error } as unknown as Record<string, unknown>);
    return ok(gameData.getEntry('hero', name, { resolveBase }) as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  'unit_kv',
  {
    title: 'Unit KeyValues',
    description:
      'Get the REAL KeyValues for a unit from npc_units (units.json): Model, stats, abilities, bounds, etc. ' +
      'Returns the declared abilities and localized name. Fuzzy suggestions on a miss.',
    inputSchema: z.object({
      name: z.string().min(1).describe('Unit name, e.g. "npc_dota_neutral_kobold".'),
      resolveBase: z.boolean().default(false).describe('Merge the implicit "npc_dota_units_base" template under the entry.'),
    }),
  },
  async ({ name, resolveBase }) => {
    const s = gameData.status;
    if (!s.loaded) return ok({ error: s.error } as unknown as Record<string, unknown>);
    return ok(gameData.getEntry('unit', name, { resolveBase }) as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  'localize',
  {
    title: 'Localization string',
    description:
      'Look up a Dota 2 localization string by key (e.g. "DOTA_Tooltip_ability_abaddon_death_coil", ' +
      '"#npc_dota_hero_axe"). Tolerates a leading "#". On a miss, returns keys whose name contains the query. ' +
      'Default language is english; pass another vendored language (see index_status.gameData.languages).',
    inputSchema: z.object({
      key: z.string().min(1).describe('Localization key (with or without a leading "#").'),
      lang: z.string().default('english').describe('Language file name, e.g. "english", "russian".'),
      limit: z.number().int().min(1).max(50).default(10).describe('Max substring suggestions on a miss.'),
    }),
  },
  async ({ key, lang, limit }) => {
    const s = gameData.status;
    if (!s.loaded) return ok({ error: s.error } as unknown as Record<string, unknown>);
    return ok(gameData.localize(key, { lang, limit }) as unknown as Record<string, unknown>);
  },
);


const transport = new StdioServerTransport();
await server.connect(transport);
log('connected over stdio');
log('activity log:', logFilePath());
writeLog({
  level: built.status.ready ? 'info' : 'error',
  event: 'startup',
  ready: built.status.ready,
  error: built.status.error ?? undefined,
  totalAssets: built.status.totalAssets,
  addon: built.addonSource ?? undefined,
});
warmup();
startWatcher();

// Best-effort: record unexpected crashes so they're in the log for later.
process.on('uncaughtException', (err) => {
  writeLog({ level: 'error', event: 'uncaughtException', error: err?.stack ?? String(err) });
  log('uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  writeLog({ level: 'error', event: 'unhandledRejection', error: String(reason) });
});
