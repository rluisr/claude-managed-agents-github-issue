#!/usr/bin/env bash
set -euo pipefail

# Persist runtime state (proper-lockfile, state.json, run-*.json) on the
# mounted Fly volume. STATE_FILE / RUN_LOCK in src/shared/constants.ts are
# resolved against process.cwd() (= /app), so we redirect that subdirectory
# to /data via a symlink instead of editing the constants.
mkdir -p /data/agent-state
if [ ! -L /app/.github-issue-agent ] \
  || [ "$(readlink /app/.github-issue-agent)" != "/data/agent-state" ]; then
  rm -rf /app/.github-issue-agent
  ln -sfn /data/agent-state /app/.github-issue-agent
fi

# --- main app ---------------------------------------------------------------
bun /app/index.ts &
APP_PID=$!
echo "[start.sh] bun server started (pid=$APP_PID)" >&2

# --- mcp-proxy sidecar ------------------------------------------------------
# Exposes the named-server stdio MCP servers in $MCP_PROXY_CONFIG as
# Streamable HTTP / SSE endpoints under /servers/<name>/mcp and
# /servers/<name>/sse respectively. Consumed by Claude Managed Agents as a
# Remote MCP server.
MCP_PROXY_HOST="${MCP_PROXY_HOST:-0.0.0.0}"
MCP_PROXY_PORT="${MCP_PROXY_PORT:-8096}"
MCP_PROXY_CONFIG="${MCP_PROXY_CONFIG:-/etc/mcp-proxy/mcp-proxy.json}"
MCP_PROXY_ALLOW_ORIGIN="${MCP_PROXY_ALLOW_ORIGIN:-*}"

if [ ! -f "$MCP_PROXY_CONFIG" ]; then
  echo "[start.sh] mcp-proxy config not found at $MCP_PROXY_CONFIG" >&2
  exit 1
fi

mcp-proxy \
  --host "$MCP_PROXY_HOST" \
  --port "$MCP_PROXY_PORT" \
  --pass-environment \
  --allow-origin "$MCP_PROXY_ALLOW_ORIGIN" \
  --named-server-config "$MCP_PROXY_CONFIG" &
PROXY_PID=$!
echo "[start.sh] mcp-proxy started (pid=$PROXY_PID, http://$MCP_PROXY_HOST:$MCP_PROXY_PORT)" >&2

shutdown() {
  echo "[start.sh] received signal, shutting down" >&2
  kill -TERM "$APP_PID" 2>/dev/null || true
  kill -TERM "$PROXY_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}

trap shutdown TERM INT

# Wait for whichever process exits first; tear down the other so Fly can
# restart the whole machine cleanly (`[[restart]] policy = 'always'`).
set +e
wait -n "$APP_PID" "$PROXY_PID"
EXIT_CODE=$?
set -e

if kill -0 "$APP_PID" 2>/dev/null; then
  echo "[start.sh] mcp-proxy exited (code=$EXIT_CODE); tearing down bun" >&2
else
  echo "[start.sh] bun exited (code=$EXIT_CODE); tearing down mcp-proxy" >&2
fi

shutdown
exit "$EXIT_CODE"
