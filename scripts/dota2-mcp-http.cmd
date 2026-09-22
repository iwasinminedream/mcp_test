@echo off
REM Shared dota2-mcp instance: ONE process serving every Codex thread and every
REM Claude Code session over streamable HTTP, instead of ~1.3 GB per client.
REM
REM The active addon cannot be inferred from cwd here (one process, many clients),
REM so it is pinned below. Switch it at runtime with the `reindex` tool:
REM     reindex { "addonPath": "C:/Users/Admin/Documents/project/<other>" }
REM Note that the switch is global -- it re-points the index for every client.

set "MCP_HTTP_PORT=7331"
set "MCP_HTTP_HOST=127.0.0.1"
set "ADDON_PATH=C:\Users\Admin\Documents\project\solo_leveling"

set "ROOT=%~dp0.."
cd /d "%ROOT%"
if not exist "logs" mkdir "logs"

REM stderr carries all diagnostics (stdout is reserved for the JSON-RPC stream in
REM stdio mode); a scheduled task has nowhere to show it, so keep it on disk.
"C:\Program Files\nodejs\node.exe" "%ROOT%\dist\server.js" --http 2>> "%ROOT%\logs\http.stderr.log"
