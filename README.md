# dota2-mcp

MCP server for Dota 2 (Source 2) modding. It gives Claude an asset index + search
and decompile-based introspection so model/particle/material names — and the
attachment points you bind particles to — are never guessed wrong.

**Milestones done (all):** M0 scaffold · M1 asset index/search/fuzzy · M2 introspection
(attachments, particle/material references, decompile) · M3 dependency graph +
attachment validation/codegen · M4 conversion (texture→PNG, model→glTF) · M5 Dota 2
API search (Lua/Panorama/CSS/enums/events/modifiers) · M6 console-log errors (byte
cursor) · active-addon loose-file indexing + live watch (compiled assets only,
`scripts/` ignored; incremental addon-scoped graph) · background warmup ·
persistent JSONL activity log + `server_log` tool. **24 tools.**

See `DOCUMENTATION.md` for the full reference, `MAINTENANCE.md` for update/debug,
per-project scoping (`--scope project`), and reading the activity log.

## Develop & build

```powershell
npm install
npm run build        # auto-downloads vendor deps (see below), then tsc
npm run smoke        # index + search demo, no MCP client needed
```

`npm run build` runs `prebuild` first, which fetches the two vendored dependencies
into `vendor/` (these are git-ignored — never committed — so a fresh clone is fully
buildable):

- **Source2Viewer-CLI** — the decompiler + its DLLs, downloaded from the latest
  [ValveResourceFormat release](https://github.com/ValveResourceFormat/ValveResourceFormat/releases)
  matching your OS/arch (`vendor/Source2Viewer-CLI/`, ~123 MB).
- **dota-data** — the Dota 2 API JSON dumps the server reads, downloaded from
  [`iwasinminedream/dota-data`](https://github.com/iwasinminedream/dota-data)
  (`files/` on `master` → `vendor/dota-data/`, ~2 MB).

Downloads are skipped when `vendor/` already exists; re-fetch with `FORCE=1`. Run
either step on its own with `npm run vendor-cli` / `npm run vendor-data`, or both
with `npm run vendor`.

**Vendor overrides** (all optional):

| Var | Effect |
|-----|--------|
| `S2V_CLI_DIR` | Copy the CLI from a local install instead of downloading (offline). |
| `S2V_CLI_TAG` | Pin a CLI release tag (e.g. `19.2`) instead of `latest`. |
| `DOTA_DATA_DIR` | Copy dota-data from a local `files/` dir instead of downloading. |
| `DOTA_DATA_REPO` / `DOTA_DATA_REF` | Use a different repo / branch-tag-commit (defaults `iwasinminedream/dota-data` @ `master`). |
| `GITHUB_TOKEN` | Authenticate GitHub requests to avoid rate limits. |
| `FORCE=1` | Re-download even if `vendor/` is already populated. |

## Configuration

- **Dota path:** auto-detected from Steam library folders. Override with `DOTA_PATH`
  (point at `...\dota 2 beta\game`).
- **Decompiler:** auto-resolved from `vendor/Source2Viewer-CLI/`, else the `S2V_CLI`
  env var. Model attachments + particle/material references need it; the asset
  index/search works without it.
- **Cache TTL:** `VPK_CACHE_TTL_MS` (default 600000 = 10 min). Decompiled artifacts
  are written to a temp dir and deleted right after reading.
- **Game/API data:** auto-resolved from `vendor/dota-data/`, else `DOTA_DATA_PATH`
  (point at a `@moddota/dota-data` `files/` dir). Vendor it with `npm run vendor-data`;
  pick localization languages with `DOTA_DATA_LANGS` (default `english,russian`).

## Register with Claude Code

A project-scoped `.mcp.json` is included. Or register explicitly:

```powershell
claude mcp add dota2-mcp -- node "C:\Users\Admin\Documents\project\mcp_test\dist\server.js"
```

## Tools

| Tool | Purpose |
|------|---------|
| `find_assets` | Substring/glob search over asset paths (filter by `kind`). |
| `resolve_asset` | Fuzzy, typo-tolerant name → real paths with score. |
| `list_dir` | Immediate sub-folders + files under a path prefix. |
| `stat_asset` | Metadata for an exact path; fuzzy suggestions on miss. |
| `model_info` | Model attachment points (`attach_*`) + referenced materials/sub-models/particles. |
| `particle_info` | Particle references, child `.vpcf` systems, function classes, max particles. |
| `material_info` | Shader name + texture references. |
| `decompile` | Any compiled `_c` resource → KV3 text (char-offset paginated). |
| `refs_from` | Assets a given asset references (outgoing deps, from its RERL block). |
| `refs_to` | Assets that reference a given asset (reverse deps — "what uses/breaks if I change X"). |
| `build_graph` | Force a (re)build of the dependency graph (else built lazily, then cached). |
| `validate_attachment` | Preflight: model + particle + attachment-name exist? Returns the model's real attachments + fuzzy suggestions. |
| `gen_attach_snippet` | Generate correct `CreateParticle`+`SetParticleControlEnt` Lua from validated paths/attachment/PATTACH type. |
| `preview_texture` | Decompile a `.vtex_c` → inline PNG image (downscaled to `maxDim`). |
| `export_model` | Decompile a `.vmdl_c` → glTF/GLB on disk (persists; `EXPORT_DIR`). |
| `api_search` / `api_get` / `api_class` | Search the Dota 2 API; full symbol detail (args/types/returns, enum members); Lua class + inherited methods. |
| `css_prop` | Panorama CSS property declaration (description + examples); fuzzy suggestions on miss. |
| `ability_kv` | Real ability KeyValues from `abilities.json` (behavior, cast range, cooldown, `AbilityValues`…) + owning hero + localized name. |
| `hero_kv` | Real hero KeyValues from `heroes.json` (model, stats, `Ability1..N`) + declared abilities + localized name. |
| `unit_kv` | Real unit KeyValues from `units.json` + declared abilities + localized name. |
| `localize` | Localization string by key (`#`-tolerant); substring suggestions on miss; pick `lang` (default english, russian vendored). |
| `console_mark` | Capture a byte cursor at the current end of `console.log` ("the moment"). |
| `console_errors` | Classified errors/warnings since a cursor (Lua tracebacks stitched, deduped, rotation-aware). |
| `console_tail` | Last N raw lines of the console log. |
| `index_status` | Indexer status, packages, addon, asset count, CLI, graph, API, game KV/localization, console. |
| `reindex` | Rebuild the index after a Dota update. |

## Share with other users (self-contained release)

```powershell
npm run package
```

Produces `release/dota2-mcp/` (and `release/dota2-mcp.zip`, ~50 MB) containing:

- `server.mjs` — the whole server bundled into one file (no `node_modules` needed),
- `vendor/Source2Viewer-CLI/` — the decompiler + its DLLs,
- `install.ps1` — one-click `claude mcp add` registration,
- `package.json`, `README.md`, `NOTICE.txt`.

The recipient needs only **Node 20+** and a **Steam Dota 2** install (Windows x64),
unzips, and runs `./install.ps1`. See `release/dota2-mcp/README.md` for details.

> `npm run package` runs bundle + vendor-cli + zip. The decompiler is downloaded
> from the latest ValveResourceFormat release (or copied from `S2V_CLI_DIR` if set).

## Design notes

- **Own VPK v2 reader** (`src/vpk/reader.ts`) — npm `vpk`/`vpk2` are old & untyped;
  we only need the directory tree for the index. Handles split archives and the
  `0x7FFF` embedded-data case. Byte output validated: the CLI fully parses files we
  extract, and entry counts match `Source2Viewer-CLI --vpk_list` (371,482).
- **In-memory index** (`src/index/assetIndex.ts`) — no native deps (deferred
  `better-sqlite3`/FTS5 to avoid Node-24 native-build friction on Windows).
- **Introspection** (`src/introspect/*`) drives `Source2Viewer-CLI` via `execFile`
  in an ephemeral temp dir. Model attachment names come from the `-a` all-blocks
  dump (the DATA block is LZ4-compressed binary KV3, so `-b DATA` and raw strings
  find nothing); references come from the clean RERL block.
- **Dependency graph** (`src/graph/depGraph.ts`) is built CLI-free by parsing each
  referrer's compiled-resource header and reading only its RERL block
  (`src/vpk/resource.ts`) — ~16 KB per file, not the whole model. ~263k edges over
  ~128k files in ~4 s, then cached to a JSON in the temp dir (invalidated by an
  index fingerprint, so a Dota patch rebuilds it).
- Runtime deps: only `@modelcontextprotocol/sdk` + `zod`; `esbuild` (dev) bundles
  the release.
