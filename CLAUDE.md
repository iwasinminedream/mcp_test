# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`dota2-mcp` — a Model Context Protocol server (stdio transport) that gives an MCP
client precise, never-guessed answers about Dota 2 (Source 2) modding assets: VPK
asset index + fuzzy search, decompile-based introspection (model attachments,
particle/material references), a dependency graph, texture/model conversion, and
search over the Dota 2 API and game KeyValues. TypeScript, ESM, Node 20+, Windows x64.
The server entry point is `src/server.ts`; the built artifact runs from `dist/server.js`.

The two reference docs are **in Russian** (the maintainer's language): `DOCUMENTATION.md`
(full architecture + per-tool reference) and `MAINTENANCE.md` (what to do on a Dota
patch / CLI update / debugging). Read those for depth; this file is the orientation.

## Commands

```powershell
npm run build       # prebuild (vendor download, ~125 MB, see below) then tsc -> dist/
npm run typecheck   # tsc --noEmit — fast, no vendor download; use this to verify edits
npm run dev         # run server from source via tsx (stdio; waits for JSON-RPC on stdin)
npm run smoke       # index + search demo, no MCP client needed
npm run package     # self-contained release -> release/dota2-mcp.zip (bundle + vendor + zip)
```

After changing server code you must `npm run build` — the registered server runs from
`dist/server.js`, not from source. Re-registration in Claude Code is usually unnecessary
(the path is stable); just restart the session to respawn the server process.

### Tests

There is no unit-test framework. Tests are standalone `tsx` scripts under `src/` that
**spawn the server and drive it over real MCP**, printing a verdict and signalling
PASS/FAIL via exit code. They require a real Steam Dota 2 install (and, for
introspection tests, the vendored decompiler). Run one at a time:

```powershell
npx tsx src/mcptest.ts        # M1/M2 round-trip (index/search + introspection)
npx tsx src/m3test.ts         # dependency graph + attachment validation/codegen
npx tsx src/m4test.ts         # texture -> PNG, model -> glTF
npx tsx src/m5test.ts         # Dota 2 API search/signatures/class inheritance
npx tsx src/gametest.ts       # css_prop + ability/hero/unit KV + localization (en/ru)
npx tsx src/m6test.ts         # console.log byte-cursor error reading
npx tsx src/addontest.ts      # active-addon indexing — run with ADDON_PATH set
npx tsx src/releasetest.ts    # spawns the PACKAGED release/server.mjs and exercises M2-M5
```

## Critical constraint: stdout is the JSON-RPC channel

This is a stdio MCP server, so **stdout carries the protocol stream — all logging must
go to stderr**. Never `console.log` from server code; use the `log` helper in
`server.ts` (which wraps `console.error`) or `console.error`. A stray stdout write
corrupts the JSON-RPC framing and breaks the client connection silently.

## Vendored dependencies (git-ignored, fetched on build)

`vendor/` is in `.gitignore` **except `vendor/dota-data/`, which is committed** (byte-exact,
`-text` in `.gitattributes`). `prebuild` (run automatically by `npm run build`) fills in
what's missing so a fresh clone is buildable:

- **`vendor/Source2Viewer-CLI/`** (~123 MB) — the ValveResourceFormat decompiler.
  Required for introspection/preview/export; the asset index and search work without it.
- **`vendor/dota-data/`** (~31 MB) — `@moddota/dota-data` JSON dumps (API, ability/hero/unit
  KV, localization) read by the `api_*` / `*_kv` / `localize` / `css_prop` tools. Kept
  current by CI, not by hand: a push to `iwasinminedream/dota-data` fires its `notify-mcp.yml`
  → `repository_dispatch` → `.github/workflows/update-dota-data.yml` here, which copies the
  files via `scripts/vendor-data.mjs` (`DOTA_DATA_DIR`) and commits them. A user-level
  SessionStart hook `git pull --ff-only`s this repo before each Claude Code session.

Downloads are skipped if `vendor/` already exists (`FORCE=1` to re-fetch). Offline/pinning
overrides: `S2V_CLI_DIR`, `S2V_CLI_TAG`, `DOTA_DATA_DIR`, `DOTA_DATA_REPO`/`DOTA_DATA_REF`,
`DOTA_DATA_LANGS`, `GITHUB_TOKEN`. `npm run vendor` runs both fetchers.

## Architecture

Layered, with `AssetSource` (`src/vpk/source.ts`) as the seam that lets VPK archives and
loose addon files be treated identically throughout the index, introspection, and graph.

```
L4  src/server.ts          — registers 29 MCP tools over stdio; registerTool is wrapped
                             (src/log.ts) to time/log every call as JSONL and catch throws
                             so a failing handler returns an isError result, not a crash.
                             Background warmup() builds the dep graph after connect.
L3  src/introspect/*        — model/particle/material/decompile via the CLI
    src/graph/depGraph.ts   — forward/reverse dependency graph, cached to JSON
    src/api/{apiData,apiIndex}.ts, api/gameData.ts — Dota 2 API + game KV + localization
    src/console/consoleLog.ts — reads console.log by byte cursor (delta since a "mark")
L2  src/index/assetIndex.ts — in-memory index, source aggregation, search; src/fuzzy.ts
    src/cache.ts            — TTL cache + ephemeral temp dirs (auto-deleted after read)
L1  src/cli/decompiler.ts   — execFile -> Source2Viewer-CLI; src/cli/convert.ts (PNG/glTF)
L0  src/vpk/reader.ts       — own VPK v2 parser (directory tree)
    src/loose/{looseDir,watcher}.ts — active addon's loose files + live watch
    src/vpk/resource.ts     — Source 2 header parser -> RERL block (for the graph)
```

`src/config.ts` resolves the Dota game dir (Steam `libraryfolders.vdf` autodetect, else
`DOTA_PATH`), the decompiler, and the dota-data path. `src/indexer.ts` assembles the
index. Tool names/wiring live in `server.ts`; `src/kinds.ts` defines asset kinds.

### Decisions that aren't obvious from the code

- **Own VPK v2 reader** — npm `vpk`/`vpk2` are old/untyped and we only need the path tree.
  Entry count is validated against `Source2Viewer-CLI --vpk_list` (371,482 in `game/dota`).
- **No native deps** — the index is plain in-memory (deferred `better-sqlite3`/FTS5 to
  avoid Node-24 native-build friction on Windows). Paths are case-insensitive like the engine.
- **CLI-free dependency graph** — running the decompiler over ~127k files is infeasible, so
  `depGraph.ts` parses each compiled-resource header and reads **only the RERL block**
  (`src/vpk/resource.ts`, ~16 KB/file). Byte-identical to the CLI's reference list. ~263k
  edges in seconds, then cached to JSON in `%TEMP%\dota2-mcp\`, invalidated by an index
  fingerprint (so a Dota patch rebuilds it). Models keep RERL at the end of the file —
  hence a header parse, not a strings scan.
- **Model attachment names** come from the CLI `-a` (all-blocks) dump matched by
  `attach_[a-z0-9_]+` — the `DATA` block is LZ4-compressed binary KV3, so `-b DATA` and
  raw-strings find nothing.
- **Ephemeral decompile cache** — decompile writes to a temp dir and deletes immediately
  after reading; parsed results are memoized by `crc32` (a patch auto-invalidates).
- **Single active addon only** — exactly one addon is indexed, resolved `ADDON_PATH` →
  `CLAUDE_PROJECT_DIR` → cwd, and its loose `_c` files override base VPK assets on path
  collision. A live watcher (`loose/watcher.ts`) keeps index+graph in sync as assets
  recompile — **compiled `_c` assets only; `scripts/` is ignored** and never enters the graph.
- **ModDota tutorials are deliberately excluded** — only the machine-generated
  `@moddota/dota-data` dumps are used (they stay in sync with the live game; tutorials rot).

## Conventions

- ESM with `NodeNext` resolution: **intra-repo imports use explicit `.js` extensions**
  (e.g. `from './indexer.js'`) even though sources are `.ts`. `tsconfig` is `strict` with
  `noUncheckedIndexedAccess` — guard array/index access.
- Tool handlers return via the `ok()` / `fail()` helpers in `server.ts` (text +
  `structuredContent`, or an `isError` message). New tools register through the wrapped
  `server.registerTool` so they are automatically timed, logged, and crash-guarded.
- The activity log (`logs/dota2-mcp.log`, JSONL) is the post-hoc debugging record; inspect
  it with the `server_log` tool or by grepping. `index_status` is the first-stop diagnostic
  for any "tool returned nothing" problem.
