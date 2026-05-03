# Deploying to Fly.io

This guide walks through hosting `github-issue-agent` on Fly.io.

> **App name caveat.** Fly.io blocks any app name containing the substring
> `github` (anti-phishing filter), so the bundled `fly.toml` uses
> `gh-issue-agent`. Pick whatever you like, just avoid `github`.

> **Ingress note.** The committed `fly.toml` exposes two `[[services]]`:
> port 3000 via `<app>.fly.dev` (HTTP/HTTPS) for the Hono dashboard, and
> port 8096 via `<app>.fly.dev:8096` (HTTPS) for the mcp-proxy sidecar.
> Single-Machine deployment is intentional — splitting the two across
> Machines would break SSE session affinity for the Remote MCP transport.

```
[ User Browser ]                    [ Claude Managed Agents ]
    │  :80 / :443                       │  :8096
    ▼                                   ▼
[ Fly Machine (nrt) ]
  ├─ bun run index.ts            (Hono SSR + run queue + SSE)   :3000
  ├─ mcp-proxy --named-server-config /etc/mcp-proxy/...         :8096
  └─ /data volume → SQLite + agent state
```

The repo ships these supporting files:

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage build: deps → Tailwind CSS → runtime (incl. mcp-proxy venv + Node.js for `npx`-based MCP servers) |
| `mcp-proxy.json` | `--named-server-config` template, baked into the image at `/etc/mcp-proxy/mcp-proxy.json` |
| `scripts/start.sh` | Spawns `bun` and `mcp-proxy` in parallel, propagates signals, exits when either dies |
| `fly.toml` | Single-machine config, `/data` volume, two `[[services]]` (3000 / 8096) |
| `.dockerignore` | Strips local state and tests from build context |

## Prerequisites

- A Fly.io account + `flyctl` installed (`brew install flyctl` / curl install)
- Anthropic API key, GitHub PAT (`repo` for classic; `contents:read`,
  `issues:write`, `pull_requests:write` for fine-grained)

## 1. Create the Fly app

```bash
# from repo root
fly apps create gh-issue-agent --org personal

# 1 GB volume in the same region
fly volumes create data --size 1 --region nrt --app gh-issue-agent
```

If you prefer `fly launch`, be aware that it rewrites `fly.toml` and may
inject an `[http_service]` block. Review the diff before committing.

## 1.5. Configure mcp-proxy (Remote MCP)

The `mcp-proxy` sidecar exposes stdio MCP servers as HTTP/SSE endpoints
that Claude Managed Agents can register as Remote MCP servers.

The default template at the repo root, `mcp-proxy.json`, is copied to
`/etc/mcp-proxy/mcp-proxy.json` inside the image. To register your own
backends, edit the template and redeploy:

```jsonc
{
  "mcpServers": {
    "<server-name>": {
      "command": "npx",
      "args": ["-y", "<package-name>", "--stdio"],
      "env": { "EXAMPLE_API_KEY": "..." }
    }
  }
}
```

> **`env` and secrets.** `--pass-environment` is enabled, so anything set
> via `fly secrets set` is visible to spawned MCP servers. Prefer that
> over inline `env` for credentials.

> **Server name → URL path.** The map key becomes a URL segment, so
> stick to URL-safe characters (kebab-case is recommended). The shipped
> example uses `"Framelink MCP for Figma"`, which works but requires
> `%20` encoding when registering the URL with Claude.

Once deployed, each server is reachable at:

```text
https://<app>.fly.dev:8096/servers/<server-name>/mcp     # Streamable HTTP
https://<app>.fly.dev:8096/servers/<server-name>/sse     # SSE (legacy)
```

Register the appropriate URL in the Claude Managed Agents `mcp_servers`
configuration.

## 2. Set Fly secrets

```bash
fly secrets set --app gh-issue-agent \
  ANTHROPIC_API_KEY='sk-ant-...' \
  GITHUB_TOKEN='ghp_...'
```

## 3. Deploy

```bash
fly deploy --app gh-issue-agent
```

Watch the logs for `Listening on http://0.0.0.0:3000`:

```bash
fly logs --app gh-issue-agent
```

## 4. Day-to-day operations

```bash
# Tail logs
fly logs --app gh-issue-agent

# SSH into the running machine
fly ssh console --app gh-issue-agent

# Check disk usage (volume is mounted at /data)
fly ssh console --app gh-issue-agent -C 'df -h /data'

# Backup the SQLite db locally
fly ssh sftp get /data/dashboard.db ./dashboard.db.bak --app gh-issue-agent

# Re-deploy after code changes
fly deploy --app gh-issue-agent
```

## Troubleshooting

- **App responds with 502**
  → The machine crashed. Inspect with
    `fly ssh console --app gh-issue-agent` and `pgrep -fa bun`. If the
    process is gone, `fly machine restart`.

- **Run lock complaint after a crash**
  → `fly ssh console --app gh-issue-agent -C 'rm /data/agent-state/run.lock.lock'`.

- **`HOST` is `127.0.0.1`**
  → Something overrode `HOST`. Inside the container it must be `0.0.0.0`
    so external ingress can reach the server.

- **mcp-proxy returns `404` on `/servers/<name>/mcp`**
  → The server name doesn't match a key in `mcp-proxy.json`. URL-encode
    spaces (`%20`). Verify the running config inside the machine:
    `fly ssh console --app gh-issue-agent -C 'cat /etc/mcp-proxy/mcp-proxy.json'`.

- **mcp-proxy fails to spawn an `npx`-based server**
  → Check logs with `fly logs --app gh-issue-agent | grep mcp-proxy`.
    The first invocation downloads the package into `/home/bun/.npm`,
    which can take 10–30s; subsequent calls are cached.

- **Either bun or mcp-proxy keeps restarting**
  → `start.sh` tears down the surviving process when either dies, so a
    crash loop in one (e.g. an mcp-proxy config error) will visibly
    restart the other. Tail `fly logs` to see which one exits first.

## Cost notes

- `shared-cpu-1x` 1 GB machine in `nrt` is roughly **$5 / month** if running
  24/7. The Fly free allowance covers up to 3 such VMs.
- `data` volume: $0.15 / GB-month.
- Anthropic billing dwarfs hosting cost (~$0.08 per session-hour at the time
  of writing). See `README.md`.
