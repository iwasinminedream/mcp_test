#!/bin/bash
# Shared dota2-mcp instance on macOS/Linux (counterpart of dota2-mcp-http.cmd): ONE
# process serving every Codex thread and Claude Code session over streamable HTTP.
# Runs in the foreground; install-http-launchd.sh / install-http-systemd.sh run it
# at login instead. Works from the repo (dist/server.js) and from a release folder
# (server.mjs next to this script).
#
#   MCP_HTTP_PORT=7331  ADDON_PATH=~/Documents/project/<addon>  scripts/dota2-mcp-http.sh
#
# The active addon cannot come from cwd here (one process, many clients): pin it with
# ADDON_PATH, or switch at runtime with  reindex { "addonPath": "..." }  (global).
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HERE/server.mjs" ]; then
    ROOT="$HERE"; SERVER="$HERE/server.mjs"
elif [ -f "$HERE/../dist/server.js" ]; then
    ROOT="$(cd "$HERE/.." && pwd)"; SERVER="$ROOT/dist/server.js"
else
    echo "dota2-mcp: server not found next to $HERE (run npm run build first)" >&2
    exit 1
fi

export MCP_HTTP_HOST="${MCP_HTTP_HOST:-127.0.0.1}"
mkdir -p "$ROOT/logs"
# stderr carries all diagnostics; keep it on disk (a login agent has no console)
exec node "$SERVER" --http "${MCP_HTTP_PORT:-7331}" 2>>"$ROOT/logs/http.stderr.log"
