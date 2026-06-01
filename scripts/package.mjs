// Assembles a self-contained, shareable release folder under release/dota2-mcp/:
//   server.mjs                  — the bundled server (no node_modules needed)
//   vendor/Source2Viewer-CLI/   — the decompiler + DLLs
//   package.json                — minimal manifest (marks the bundle root)
//   README.md, NOTICE.txt       — recipient instructions + third-party license
//   install.ps1                 — one-click registration with Claude Code
//
// Prereqs: bundle + vendored CLI (this script runs both automatically).
import {
  rmSync, mkdirSync, cpSync, existsSync, writeFileSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const RECIPIENT_README = `# dota2-mcp

A local MCP server that lets Claude introspect **Dota 2 (Source 2)** assets so it
never guesses model/particle/material names. Fully self-contained: this folder
includes the bundled server **and** the Source2Viewer decompiler.

## Requirements

- **Windows x64** (the bundled decompiler is win-x64).
- **Node.js 20+** installed and on PATH (\`node --version\`).
- **Dota 2 installed via Steam** (auto-detected from Steam library folders; if it
  isn't found, set the \`DOTA_PATH\` env var to your \`...\\dota 2 beta\\game\` folder).

## Install (Claude Code)

From this folder, run in PowerShell:

\`\`\`powershell
./install.ps1
\`\`\`

That registers the server with: \`claude mcp add dota2-mcp -- node "<this folder>\\server.mjs"\`.
Then restart Claude Code and check \`/mcp\`.

### Manual / Claude Desktop

Add to your MCP config (\`mcpServers\`):

\`\`\`json
{
  "mcpServers": {
    "dota2-mcp": {
      "command": "node",
      "args": ["C:\\\\full\\\\path\\\\to\\\\dota2-mcp\\\\server.mjs"]
    }
  }
}
\`\`\`

## Tools

- \`find_assets\`, \`resolve_asset\` (fuzzy), \`list_dir\`, \`stat_asset\` — asset index + search.
- \`model_info\` — model attachment points + referenced materials/sub-models.
- \`particle_info\` — particle references, child systems, function classes.
- \`material_info\` — shader + texture references.
- \`decompile\` — any compiled resource to KV3 text.
- \`index_status\`, \`reindex\`.

## Notes

- Decompiled artifacts are written to a temp dir and deleted right after reading
  (TTL configurable via \`VPK_CACHE_TTL_MS\`).
- The decompiler is bundled in \`vendor/\`; override with the \`S2V_CLI\` env var.
`;

const NOTICE = `dota2-mcp bundles third-party software:

Source 2 Viewer / ValveResourceFormat (Source2Viewer-CLI.exe and DLLs)
  https://github.com/ValveResourceFormat/ValveResourceFormat
  License: MIT

The bundled libraries (SkiaSharp, spirv-cross, TinyEXR, BLAKE3) are distributed
under their respective permissive licenses. See the ValveResourceFormat repository
for full license texts.

Dota 2 and Source 2 are trademarks of Valve Corporation. This tool reads assets
from your own local Dota 2 installation and ships no Valve game content.
`;

const INSTALL_PS1 = `# Registers dota2-mcp with Claude Code using this folder's absolute path.
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $dir 'server.mjs'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'Node.js not found on PATH. Install Node 20+ from https://nodejs.org and retry.'
  exit 1
}
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host 'Claude Code CLI ("claude") not found. Add this manually to your MCP config:' -ForegroundColor Yellow
  Write-Host ('  command: node') -ForegroundColor Yellow
  Write-Host ('  args:    ["' + $server + '"]') -ForegroundColor Yellow
  exit 0
}

claude mcp remove dota2-mcp 2>$null | Out-Null
claude mcp add dota2-mcp -- node "$server"
Write-Host ''
Write-Host 'Registered dota2-mcp. Restart Claude Code and run /mcp to verify.' -ForegroundColor Green
`;

const ROOT = process.cwd();
const OUT = join(ROOT, 'release', 'dota2-mcp');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// 1. Build the bundle and vendor the CLI (idempotent).
execFileSync('node', ['scripts/bundle.mjs'], { stdio: 'inherit' });
if (!existsSync(join(ROOT, 'vendor', 'Source2Viewer-CLI'))) {
  execFileSync('node', ['scripts/vendor-cli.mjs'], { stdio: 'inherit' });
}
if (!existsSync(join(ROOT, 'vendor', 'dota-data'))) {
  execFileSync('node', ['scripts/vendor-data.mjs'], { stdio: 'inherit' });
}

// 2. Fresh release dir.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 3. Copy artifacts.
cpSync(join(ROOT, 'bundle', 'server.mjs'), join(OUT, 'server.mjs'));
cpSync(join(ROOT, 'vendor'), join(OUT, 'vendor'), { recursive: true });

// 4. Minimal manifest so packageRoot() resolves the bundle dir, Node treats it as ESM.
writeFileSync(
  join(OUT, 'package.json'),
  JSON.stringify(
    { name: 'dota2-mcp', version: pkg.version, private: true, type: 'module', bin: { 'dota2-mcp': 'server.mjs' } },
    null,
    2,
  ) + '\n',
);

// 5-7. Docs + installer.
writeFileSync(join(OUT, 'README.md'), RECIPIENT_README);
writeFileSync(join(OUT, 'NOTICE.txt'), NOTICE);
writeFileSync(join(OUT, 'install.ps1'), INSTALL_PS1);

// 8. Zip it (Windows PowerShell Compress-Archive).
const zip = join(ROOT, 'release', 'dota2-mcp.zip');
rmSync(zip, { force: true });
try {
  execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `Compress-Archive -Path '${OUT}\\*' -DestinationPath '${zip}' -Force`],
    { stdio: 'inherit' },
  );
  console.log('\nrelease zip -> ' + zip);
} catch {
  console.log('\nrelease folder -> ' + OUT + ' (zip step skipped; PowerShell unavailable)');
}
console.log('release folder -> ' + OUT);
