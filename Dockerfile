# syntax=docker/dockerfile:1.7

# github-issue-agent runtime image.
#
# Layout:
#   /app           - application code (read-only at runtime)
#   /data          - mounted Fly volume; SQLite + agent state live here
#   /app/.github-issue-agent -> /data/agent-state (symlink, set by start.sh)
#
# A cloudflared binary is embedded so Cloudflare Tunnel can run as a sidecar
# in the same machine. When CLOUDFLARE_TUNNEL_TOKEN is set, the tunnel is
# started by scripts/start.sh; otherwise the server is reachable only on the
# Fly private network (or whatever ingress you wire up).

ARG BUN_IMAGE=oven/bun:1.3-debian

# Pinned for reproducibility; bump when upgrading cloudflared.
FROM cloudflare/cloudflared:2025.7.0 AS cloudflared

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock bunfig.toml tsconfig.json tailwind.config.ts ./
COPY src ./src
RUN bun run build:css

FROM ${BUN_IMAGE} AS runtime

# tini: proper PID 1 / signal forwarding.
# bash: scripts/start.sh uses `wait -n`, which dash does not support.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates bash \
  && rm -rf /var/lib/apt/lists/*

COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY index.ts ./index.ts
COPY src ./src
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY scripts ./scripts
COPY --from=build /app/dist ./dist

RUN mkdir -p /data \
  && chown -R bun:bun /data /app \
  && chmod +x ./scripts/start.sh

USER bun

# Defaults; override in fly.toml or via `fly secrets set` as needed.
ENV HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/dashboard.db \
    LOG_LEVEL=info \
    NODE_ENV=production

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./scripts/start.sh"]
