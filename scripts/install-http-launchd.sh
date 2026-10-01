#!/bin/bash
# macOS counterpart of install-http-task.ps1: registers the shared dota2-mcp HTTP
# server (127.0.0.1:7331) as a LaunchAgent — starts at login, restarts on crash —
# and points Claude Code / Codex at it. Works from the repo (dist/server.js) and
# from a release folder (server.mjs next to this script; there it is install.sh).
#
#   ./install-http-launchd.sh [--port 7331] [--addon <project dir>] [--no-register] [--uninstall]
set -eu

LABEL="com.dota2-mcp.http"
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

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [ "$UNINSTALL" = 1 ]; then
    rm -f "$PLIST"
    command -v claude >/dev/null 2>&1 && claude mcp remove --scope user dota2-mcp >/dev/null 2>&1 || true
    echo "removed $LABEL"
    exit 0
fi

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js not found (brew install node)" >&2; exit 1; }
if [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
    echo "Node 20+ required (have $("$NODE" -v))" >&2; exit 1
fi

# A release unpacked on a Mac: the decompiler needs its exec bit, and files from a
# downloaded archive carry the quarantine flag that Gatekeeper would block.
CLI="$ROOT/vendor/Source2Viewer-CLI/Source2Viewer-CLI"
[ -f "$CLI" ] && chmod +x "$CLI"
xattr -dr com.apple.quarantine "$ROOT" 2>/dev/null || true
mkdir -p "$ROOT/logs" "$(dirname "$PLIST")"

esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
ADDON_XML=""
[ -n "$ADDON" ] && ADDON_XML="<key>ADDON_PATH</key><string>$(esc "$ADDON")</string>"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(esc "$NODE")</string>
        <string>$(esc "$SERVER")</string>
        <string>--http</string>
        <string>$PORT</string>
    </array>
    <key>WorkingDirectory</key><string>$(esc "$ROOT")</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>MCP_HTTP_HOST</key><string>127.0.0.1</string>
        <key>PATH</key><string>$(esc "$(dirname "$NODE")"):/usr/bin:/bin:/usr/sbin:/sbin</string>
        $ADDON_XML
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>30</integer>
    <key>StandardOutPath</key><string>$(esc "$ROOT/logs/http.stdout.log")</string>
    <key>StandardErrorPath</key><string>$(esc "$ROOT/logs/http.stderr.log")</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "registered $LABEL -> $SERVER (port $PORT)"

# The index is built before the port opens: give it a moment.
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
