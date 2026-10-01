#!/bin/bash
# Linux counterpart of install-http-task.ps1: runs the shared dota2-mcp HTTP server
# (127.0.0.1:7331) as a systemd --user service — starts at login, restarts on crash —
# and points Claude Code / Codex at it. Works from the repo (dist/server.js) and from
# a release folder (server.mjs next to this script; there it is install.sh).
#
#   ./install-http-systemd.sh [--port 7331] [--addon <project dir>] [--no-register] [--uninstall]
set -eu

UNIT_NAME="dota2-mcp-http.service"
PORT="${MCP_HTTP_PORT:-7331}"
ADDON="${ADDON_PATH:-}"
REGISTER=1
UNINSTALL=0
while [ $# -gt 0 ]; do
    case "$1" in
        --port) PORT="$2"; shift 2 ;;
        --addon) ADDON="$2"; shift 2 ;;
        --no-register) REGISTER=0; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HERE/server.mjs" ]; then
    ROOT="$HERE"; SERVER="$HERE/server.mjs"
elif [ -f "$HERE/../dist/server.js" ]; then
    ROOT="$(cd "$HERE/.." && pwd)"; SERVER="$ROOT/dist/server.js"
else
    echo "server not found next to $HERE (run npm run build first)" >&2
    exit 1
fi

UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT_NAME"
if [ "$UNINSTALL" = 1 ]; then
    systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
    rm -f "$UNIT"
    systemctl --user daemon-reload
    command -v claude >/dev/null 2>&1 && claude mcp remove --scope user dota2-mcp >/dev/null 2>&1 || true
    echo "removed $UNIT_NAME"
    exit 0
fi

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js not found" >&2; exit 1; }
if [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
    echo "Node 20+ required (have $("$NODE" -v))" >&2; exit 1
fi

CLI="$ROOT/vendor/Source2Viewer-CLI/Source2Viewer-CLI"
[ -f "$CLI" ] && chmod +x "$CLI"
mkdir -p "$ROOT/logs" "$(dirname "$UNIT")"

{
    echo "[Unit]"
    echo "Description=Shared dota2-mcp server (streamable HTTP on 127.0.0.1:$PORT)"
    echo
    echo "[Service]"
    echo "ExecStart=\"$NODE\" \"$SERVER\" --http $PORT"
    echo "WorkingDirectory=$ROOT"
    echo "Environment=MCP_HTTP_HOST=127.0.0.1"
    [ -n "$ADDON" ] && echo "Environment=\"ADDON_PATH=$ADDON\""
    echo "Restart=always"
    echo "RestartSec=30"
    echo "StandardError=append:$ROOT/logs/http.stderr.log"
    echo
    echo "[Install]"
    echo "WantedBy=default.target"
} > "$UNIT"
systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME"
echo "registered $UNIT_NAME -> $SERVER (port $PORT)"

URL="http://127.0.0.1:$PORT"
i=0
until curl -fsS "$URL/health" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge 120 ]; then echo "no answer on $URL/health yet — see $ROOT/logs/http.stderr.log" >&2; break; fi
    sleep 1
done
curl -fsS "$URL/health" 2>/dev/null | head -c 400 && echo

if [ "$REGISTER" = 1 ]; then
    if command -v claude >/dev/null 2>&1; then
        claude mcp remove --scope user dota2-mcp >/dev/null 2>&1 || true
        claude mcp add --scope user --transport http dota2-mcp "$URL/mcp" && echo "Claude Code: dota2-mcp -> $URL/mcp"
    fi
    CODEX="$HOME/.codex/config.toml"
    if [ -f "$CODEX" ] && ! grep -q '^\[mcp_servers\.dota2-mcp\]' "$CODEX"; then
        printf '\n[mcp_servers.dota2-mcp]\nurl = "%s/mcp"\n' "$URL" >> "$CODEX"
        echo "Codex: dota2-mcp -> $URL/mcp"
    fi
fi
