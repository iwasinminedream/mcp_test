// Assembles a self-contained, shareable release folder:
//   server.mjs                  — the bundled server (no node_modules needed)
//   vendor/Source2Viewer-CLI/   — the decompiler for the TARGET OS/arch
//   vendor/dota-data/           — API / game KV / localization dumps
//   package.json                — minimal manifest (marks the bundle root)
//   README.md, NOTICE.txt       — recipient instructions + third-party license
//   install.ps1 (Windows)       — one-click registration with Claude Code
//   install.sh + dota2-mcp-http.sh (macOS/Linux) — login agent/service + registration
//
//   npm run package                          -> release/dota2-mcp/ (+ .zip | .tar.gz), this machine
//   npm run package -- --target darwin-arm64 -> release/dota2-mcp-darwin-arm64/ + .tar.gz
//
// Targets: win32-x64, win32-arm64, darwin-arm64, darwin-x64, linux-x64, linux-arm64.
// Any target can be built on any host (the CLI is downloaded for the target).
import {
  rmSync, mkdirSync, cpSync, existsSync, writeFileSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const host = `${process.platform}-${process.arch}`;
const tIdx = process.argv.indexOf('--target');
const target = tIdx !== -1 ? process.argv[tIdx + 1] : host;
const [tOs, tArch] = (target ?? '').split('-');
if (!['win32', 'darwin', 'linux'].includes(tOs) || !['x64', 'arm64'].includes(tArch)) {
  console.error(`Unknown --target "${target}". Use win32|darwin|linux - x64|arm64, e.g. darwin-arm64.`);
  process.exit(1);
}
const isWin = tOs === 'win32';
// The plain host build keeps its historical name (src/releasetest.ts spawns release/dota2-mcp/).
const NAME = tIdx === -1 ? 'dota2-mcp' : `dota2-mcp-${target}`;
const OUT = join(ROOT, 'release', NAME);

const OS_LABEL = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[tOs];
const README_WIN = `# dota2-mcp (${OS_LABEL} ${tArch})

A local MCP server that lets Claude introspect **Dota 2 (Source 2)** assets so it
never guesses model/particle/material names. Fully self-contained: this folder
includes the bundled server **and** the Source2Viewer decompiler.

## Requirements

- **${OS_LABEL} ${tArch}** (the bundled decompiler is built for it).
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
`;

const SERVICE = tOs === 'darwin' ? 'a LaunchAgent (starts at login, restarts on crash)' : 'a systemd --user service';
const STEAM_HINT =
  tOs === 'darwin'
    ? '`~/Library/Application Support/Steam/steamapps/common/dota 2 beta/game`'
    : '`~/.steam/steam/steamapps/common/dota 2 beta/game` (also `~/.local/share/Steam`, Flatpak, Snap)';
const README_POSIX = `# dota2-mcp (${OS_LABEL} ${tArch})

A local MCP server that lets Claude / Codex introspect **Dota 2 (Source 2)** assets
and search the Dota 2 API, game KeyValues and localization. Fully self-contained:
the bundled server, the Source2Viewer decompiler for ${OS_LABEL} ${tArch} and the
API dumps are all in this folder.

## Requirements

- **Node.js 20+** on PATH (\`node --version\`; macOS: \`brew install node\`).
- **Dota 2 installed via Steam** — auto-detected at ${STEAM_HINT}
  and in Steam's \`libraryfolders.vdf\`. Otherwise set \`DOTA_PATH\` to the
  \`.../dota 2 beta/game\` folder. Without Dota the API / KV / localization tools still work.

## Install

\`\`\`bash
bash install.sh                                 # shared HTTP server on 127.0.0.1:7331
bash install.sh --addon ~/Documents/project/<addon>   # + pin the active addon
\`\`\`

\`install.sh\` registers ${SERVICE}, waits for \`/health\`, and points Claude Code
(\`claude mcp add --scope user --transport http dota2-mcp http://127.0.0.1:7331/mcp\`)
and Codex (\`[mcp_servers.dota2-mcp] url\` in \`~/.codex/config.toml\`) at it.
Remove with \`bash install.sh --uninstall\`. Logs: \`logs/\` in this folder.

Foreground run instead: \`bash dota2-mcp-http.sh\`, or stdio per client:
\`claude mcp add dota2-mcp -- node "$PWD/server.mjs"\`.

## What works where

- Asset index/search, dependency graph, API / KV / localization, the addon watcher — everywhere.
- \`decompile\`, \`model_info\`, \`particle_info\`, \`material_info\`, \`preview_texture\`,
  \`export_model\` — via the bundled Source2Viewer-CLI.
- \`console_*\` read \`<game>/dota/console.log\`: launch Dota with \`-condebug\`.
  Workshop Tools (and with them compiling addon content) exist only on Windows.
`;

const NOTICE = `dota2-mcp bundles third-party software:

Source 2 Viewer / ValveResourceFormat (Source2Viewer-CLI and its native libraries)
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

/** Copies a repo shell script into the release with LF endings (git may check it out as CRLF on Windows). */
function writeSh(src, dst) {
  writeFileSync(dst, readFileSync(join(ROOT, 'scripts', src), 'utf8').replace(/\r\n/g, '\n'), { mode: 0o755 });
}

// 1. Bundle the server (plain JS, the same for every target).
execFileSync(process.execPath, ['scripts/bundle.mjs'], { stdio: 'inherit' });

// 2. Decompiler for the target: this machine's vendor/ copy, or a per-target cache.
let cliDir = join(ROOT, 'vendor', 'Source2Viewer-CLI');
if (target !== host) cliDir = join(ROOT, 'release', '.cli', target);
const cliExe = join(cliDir, isWin ? 'Source2Viewer-CLI.exe' : 'Source2Viewer-CLI');
if (!existsSync(cliExe)) {
  execFileSync(process.execPath, ['scripts/vendor-cli.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, S2V_CLI_TARGET: target, S2V_CLI_DEST: cliDir, S2V_CLI_DIR: '' },
  });
}
if (!existsSync(join(ROOT, 'vendor', 'dota-data'))) {
  execFileSync(process.execPath, ['scripts/vendor-data.mjs'], { stdio: 'inherit' });
}

// 3. Fresh release dir.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'vendor'), { recursive: true });
cpSync(join(ROOT, 'bundle', 'server.mjs'), join(OUT, 'server.mjs'));
cpSync(cliDir, join(OUT, 'vendor', 'Source2Viewer-CLI'), { recursive: true });
cpSync(join(ROOT, 'vendor', 'dota-data'), join(OUT, 'vendor', 'dota-data'), { recursive: true });

// 4. Minimal manifest so packageRoot() resolves the bundle dir, Node treats it as ESM.
writeFileSync(
  join(OUT, 'package.json'),
  JSON.stringify(
    { name: 'dota2-mcp', version: pkg.version, private: true, type: 'module', bin: { 'dota2-mcp': 'server.mjs' } },
    null,
    2,
  ) + '\n',
);

// 5. Docs + installer for the target OS.
writeFileSync(join(OUT, 'NOTICE.txt'), NOTICE);
if (isWin) {
  writeFileSync(join(OUT, 'README.md'), README_WIN);
  writeFileSync(join(OUT, 'install.ps1'), INSTALL_PS1);
} else {
  writeFileSync(join(OUT, 'README.md'), README_POSIX);
  writeSh(tOs === 'darwin' ? 'install-http-launchd.sh' : 'install-http-systemd.sh', join(OUT, 'install.sh'));
  writeSh('dota2-mcp-http.sh', join(OUT, 'dota2-mcp-http.sh'));
}

// 6. Archive: .zip for Windows (contents at the root, as before), .tar.gz with a
// top-level folder for macOS/Linux. tar ships with Windows 10+ (bsdtar), macOS, Linux.
const tarBin = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
let archive;
try {
  if (isWin) {
    archive = join(ROOT, 'release', `${NAME}.zip`);
    rmSync(archive, { force: true });
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command',
        `Compress-Archive -Path '${OUT}\\*' -DestinationPath '${archive}' -Force`], { stdio: 'inherit' });
    } else {
      execFileSync('zip', ['-qr', archive, '.'], { cwd: OUT, stdio: 'inherit' });
    }
  } else {
    archive = join(ROOT, 'release', `${NAME}.tar.gz`);
    rmSync(archive, { force: true });
    execFileSync(tarBin, ['-czf', `${NAME}.tar.gz`, NAME], { cwd: join(ROOT, 'release'), stdio: 'inherit' });
  }
  console.log('\nrelease archive -> ' + archive);
} catch (err) {
  console.log('\narchive step skipped: ' + (err instanceof Error ? err.message : err));
}
console.log('release folder  -> ' + OUT);
