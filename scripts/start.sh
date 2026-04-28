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

TUNNEL_PID=""

if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  cloudflared tunnel --no-autoupdate run --token "$CLOUDFLARE_TUNNEL_TOKEN" &
  TUNNEL_PID=$!
  echo "[start.sh] cloudflared started (pid=$TUNNEL_PID)" >&2
else
  echo "[start.sh] CLOUDFLARE_TUNNEL_TOKEN not set; skipping cloudflared" >&2
fi

bun /app/index.ts &
APP_PID=$!
echo "[start.sh] bun server started (pid=$APP_PID)" >&2

shutdown() {
  echo "[start.sh] received signal, shutting down" >&2
  kill -TERM "$APP_PID" 2>/dev/null || true
  if [ -n "$TUNNEL_PID" ]; then
    kill -TERM "$TUNNEL_PID" 2>/dev/null || true
  fi
  wait
}

trap shutdown TERM INT

# Whichever child exits first triggers the teardown so Fly will recreate the
# machine cleanly. Exit code from the child propagates to the supervisor.
set +e
if [ -n "$TUNNEL_PID" ]; then
  wait -n "$APP_PID" "$TUNNEL_PID"
else
  wait "$APP_PID"
fi
EXIT_CODE=$?
set -e

echo "[start.sh] child exited with code=$EXIT_CODE; tearing down" >&2
shutdown
exit "$EXIT_CODE"
