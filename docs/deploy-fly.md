# Deploying to Fly.io with Cloudflare Access (OIDC)

This guide walks through hosting `github-issue-agent` on Fly.io with a
Cloudflare Tunnel sidecar and Cloudflare Access for OIDC-based authentication.

> **App name caveat.** Fly.io blocks any app name containing the substring
> `github` (anti-phishing filter), so the bundled `fly.toml` uses
> `gh-issue-agent`. Pick whatever you like, just avoid `github`.

> **!! SECURITY-CRITICAL !!**
>
> Two ingresses must be disabled on the Fly side, or Cloudflare Access (OIDC)
> is silently bypassed:
>
> 1. The committed `fly.toml` MUST NOT contain `[http_service]`,
>    `[[services]]`, or `[[services.ports]]`. `fly launch` re-injects
>    `[http_service]` even with `--copy-config`, so DO NOT run `fly launch`
>    for this app -- use `fly apps create` (step 1 below).
> 2. Public IPv4/IPv6 addresses on the Fly app must be released. As long as
>    one is attached, `<app>.fly.dev` resolves and the Fly edge proxy will
>    forward to your machine, even without `[http_service]`. Run
>    `scripts/fly-release-public-ips.sh` after every deploy.
>
> Verify both by `curl -I https://<app>.fly.dev/` returning a connection
> error, not an HTTP response.

```
[ User Browser ]
    │  (OIDC: Google / GitHub / Okta / etc.)
    ▼
[ Cloudflare Access ]   ← login enforced here, app code unchanged
    │  (Cloudflare Tunnel)
    ▼
[ Fly Machine (nrt) ]
  ├─ bun run index.ts          (Hono SSR + run queue + SSE)
  ├─ cloudflared --token ...   (sidecar)
  └─ /data volume → SQLite + agent state
```

The repo ships these supporting files:

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage build: deps → Tailwind CSS → runtime + cloudflared |
| `scripts/start.sh` | Spawns `bun` and `cloudflared`, propagates signals |
| `scripts/fly-release-public-ips.sh` | Releases all public IPs of the Fly app |
| `fly.toml` | Single-machine config, `/data` volume, TCP healthcheck, **no proxy bindings** |
| `.dockerignore` | Strips local state and tests from build context |

## Prerequisites

- A Cloudflare account with a domain managed in it (e.g. `agent.example.com`)
- A Fly.io account + `flyctl` installed (`brew install flyctl` / curl install)
- `jq` installed (`fly-release-public-ips.sh` needs it)
- Anthropic API key, GitHub PAT (`repo` for classic; `contents:read`,
  `issues:write`, `pull_requests:write` for fine-grained)

## 1. Create the Fly app (without `fly launch`)

`fly launch` rewrites `fly.toml` and injects `[http_service]`. Use the
lower-level command instead so the committed file stays intact.

```bash
# from repo root
fly apps create gh-issue-agent --org personal

# 1 GB volume in the same region
fly volumes create data --size 1 --region nrt --app gh-issue-agent
```

If you already ran `fly launch` and `fly.toml` was rewritten:

```bash
git checkout -- fly.toml      # restore the security-hardened version
diff <(grep -E 'http_service|\[\[services' fly.toml) /dev/null
# Expected: no output. If grep matches, the rewrite is back -- abort and
# investigate before deploying.
```

## 2. Set Fly secrets

```bash
fly secrets set --app gh-issue-agent \
  ANTHROPIC_API_KEY='sk-ant-...' \
  GITHUB_TOKEN='ghp_...'
```

The Cloudflare tunnel token is set after step 3.

## 3. Create a Cloudflare Tunnel

In Cloudflare dashboard → **Zero Trust** → **Networks** → **Tunnels**:

1. **Create a tunnel** → name it (e.g. `gh-issue-agent`)
2. Choose **Cloudflared** as the connector type
3. On the install screen, copy the **token** value
   (`eyJh...` long string). This is `CLOUDFLARE_TUNNEL_TOKEN`.
4. Under **Public Hostname**, add a route:
   - Subdomain: `agent`
   - Domain: `example.com`
   - Service type: `HTTP`
   - URL: `localhost:3000`

Push the token into Fly:

```bash
fly secrets set --app gh-issue-agent CLOUDFLARE_TUNNEL_TOKEN='eyJh...'
```

## 4. First deploy + lock down public ingress

```bash
fly deploy --app gh-issue-agent

# !!! ALWAYS run this immediately after a deploy. !!!
# Fly auto-attaches a public IPv6 to new apps.
scripts/fly-release-public-ips.sh gh-issue-agent
```

Verify the lockdown:

```bash
# Should fail with `Could not resolve host` or a connection refused error.
# If it returns ANY HTTP response (even 502/404), the app is still public.
curl -I --max-time 5 https://gh-issue-agent.fly.dev/
```

Watch the logs for both `[start.sh] cloudflared started` and
`Listening on http://0.0.0.0:3000`:

```bash
fly logs --app gh-issue-agent
```

Open `https://agent.example.com` once the Cloudflare tunnel reports
**HEALTHY** in the dashboard.

## 5. Configure Cloudflare Access (OIDC)

In Cloudflare dashboard → **Zero Trust** → **Access** → **Applications**:

1. **Add an application** → **Self-hosted**
2. Application domain: `agent.example.com`
3. **Identity providers**: pick the OIDC provider you want to enforce.
   - Google / GitHub / Microsoft / Slack are one-click integrations
   - Generic OIDC (Auth0 / Okta / Keycloak / etc.) lives under
     **Settings → Authentication → Add new**
4. **Policy**: at minimum one allow rule.
   Examples:
   - `Emails ending in @example.com`
   - `Email is foo@example.com`
   - `GitHub organization is example-org` (if GitHub IdP)
   - `WARP is enabled` (require Cloudflare WARP / device posture)
5. Save. The application is now gated by OIDC login.

The app receives `Cf-Access-Authenticated-User-Email` headers if you ever
want to identify users in-app, but the current code does not read them -
authentication is enforced entirely at the Cloudflare edge.

### Service tokens (CI/automation bypass)

To call `POST /api/runs` from CI without a browser flow:

1. Cloudflare Access → **Service Auth** → **Create Service Token**
2. Add a **Bypass / Service Auth** policy on the application that
   matches the token
3. Send the token as headers:

```bash
curl https://agent.example.com/api/runs \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"issue":42,"repo":"owner/name","dryRun":false}'
```

## 6. Day-to-day operations

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
scripts/fly-release-public-ips.sh gh-issue-agent  # always re-run after deploy
```

## Troubleshooting

- **`https://<app>.fly.dev/` returns an HTTP response (even 404/502)**
  → Cloudflare Access is currently bypassed. Either (a) `fly.toml` got
    `[http_service]` re-injected, (b) a public IP is attached, or both.
    Check with:
    ```bash
    fly ips list --app gh-issue-agent
    grep -E 'http_service|\[\[services' fly.toml
    ```
    Fix: `git checkout -- fly.toml`, redeploy, then run the release script.
    Rotate `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` if the window was long.

- **`fly logs` shows `CLOUDFLARE_TUNNEL_TOKEN not set`**
  → `fly secrets set --app gh-issue-agent CLOUDFLARE_TUNNEL_TOKEN=...`
    then `fly machine restart --app gh-issue-agent`.

- **Cloudflare Tunnel reports DOWN**
  → Check `fly logs --app gh-issue-agent | grep cloudflared`. Token mismatch
    or the machine cannot reach `*.cloudflareaccess.com`. The egress is
    HTTPS, so any upstream network ACL must allow that.

- **App responds with 502 via Cloudflare**
  → The tunnel is up but the app crashed. Inspect with
    `fly ssh console --app gh-issue-agent` and `pgrep -fa bun`. start.sh
    should kill cloudflared too; if not, `fly machine restart`.

- **Run lock complaint after a crash**
  → `fly ssh console --app gh-issue-agent -C 'rm /data/agent-state/run.lock.lock'`.

- **`HOST` is `127.0.0.1`**
  → Something overrode `HOST`. Inside the container it must be `0.0.0.0`
    so cloudflared (running on the same machine) can reach it.

- **`fly deploy` keeps re-attaching public IPs**
  → Expected. Fly auto-allocates a public IPv6 on every fresh allocation.
    The mitigation is to always run `scripts/fly-release-public-ips.sh`
    after `fly deploy`. CI/CD should chain them.

## Cost notes

- `shared-cpu-1x` 1 GB machine in `nrt` is roughly **$5 / month** if running
  24/7. The Fly free allowance covers up to 3 such VMs.
- `data` volume: $0.15 / GB-month.
- Cloudflare Access: free for up to 50 seats.
- Anthropic billing dwarfs hosting cost (~$0.08 per session-hour at the time
  of writing). See `README.md`.
