# @felipefontoura/paperclip-skills-bridge

A small HTTP service that exposes your [Paperclip](https://paperclip.ai) skills to a [Hermes Agent](https://github.com/NousResearch/hermes-agent).

You run it as a container next to Hermes. It calls Paperclip's HTTP API on your behalf and serves the result in the `.well-known/skills/` format Hermes already understands. Paperclip stays the source of truth — the bridge is stateless and caches nothing.

Works together with [`@felipefontoura/paperclip-adapter-hermes-gateway`](https://github.com/felipefontoura/paperclip-adapter-hermes-gateway), the Paperclip plugin that talks to Hermes through this bridge.

## Run it

```bash
docker run --rm -d \
  --name paperclip-skills-bridge \
  -e PAPERCLIP_URL=https://paperclip.example.com \
  -e PAPERCLIP_COMPANY_ID=<your-company-uuid> \
  -e PAPERCLIP_API_KEY=<paperclip-machine-bearer> \
  -e BRIDGE_AUTH_TOKEN=<a-strong-random-string> \
  -p 8080:8080 \
  ghcr.io/felipefontoura/paperclip-skills-bridge:0.1.0
```

Verify:

```bash
curl http://localhost:8080/health
# → {"ok":true}

curl http://localhost:8080/whoami -H "Authorization: Bearer <BRIDGE_AUTH_TOKEN>"
# → {"companyId":"<your-company-uuid>"}
```

Now point the Paperclip agent at `http://<bridge-host>:8080` (the adapter discovers the company UUID and adds it to the URL automatically).

## What it serves

Once a tenant is configured, the bridge exposes:

| Path | Returns |
|---|---|
| `GET /health` | `{"ok":true}` — public, always on. |
| `GET /whoami` | The `companyId` your bearer maps to. Handy for finding your company UUID. |
| `GET /companies/<companyId>/.well-known/skills/index.json` | The skill catalog (`name`, `description`, `files[]`). |
| `GET /companies/<companyId>/.well-known/skills/<name>/<file>` | A file declared in that skill's manifest (`SKILL.md`, `references/00-canon.md`, `templates/scene-rewrite.md`, …). Anything not declared returns 404. |

All `.well-known/skills/*` requests require `Authorization: Bearer <token>`.

## Configuration

| Variable | What it is | Default |
|---|---|---|
| `PAPERCLIP_URL` | Base URL of your Paperclip instance. | `http://paperclip:3100` |
| `PAPERCLIP_COMPANY_ID` | UUID of the Paperclip company whose skills you want to expose. | — |
| `PAPERCLIP_API_KEY` | Machine bearer for Paperclip (recommended for production). | — |
| `PAPERCLIP_SESSION_COOKIE` | User session cookie. **Dev only.** | — |
| `BRIDGE_AUTH_TOKEN` | Bearer that callers must present. **Mandatory** once the bridge is reachable outside an isolated network. | — |
| `BRIDGE_TENANTS` | JSON array for multi-tenant mode (see below). When set, **replaces** the four variables above. | — |
| `PAPERCLIP_FETCH_TIMEOUT_MS` | Outbound timeout to Paperclip (clamped 500–60000). | `5000` |
| `BRIDGE_RATE_LIMIT_MAX` | Per-IP requests per window. | `100` |
| `BRIDGE_RATE_LIMIT_WINDOW_MS` | Rate-limit window in ms. | `60000` |

## Hosting more than one Paperclip company

Replace the four single-tenant variables with `BRIDGE_TENANTS`:

```bash
BRIDGE_TENANTS='[
  {
    "companyId": "af724ed6-612e-466b-b733-dd00e0371236",
    "bridgeToken": "tenant-a-bearer",
    "paperclipApiKey": "paperclip-machine-bearer-for-a"
  },
  {
    "companyId": "00112233-4455-6677-8899-aabbccddeeff",
    "bridgeToken": "tenant-b-bearer",
    "paperclipApiKey": "paperclip-machine-bearer-for-b"
  }
]'
```

A request to `/companies/<id>/.well-known/skills/...` only succeeds if the bearer matches the tenant whose `companyId === <id>`. Cross-tenant calls return `403`, missing or wrong bearers return `401`.

To find any tenant's `companyId` for the JSON above, ask the bridge:

```bash
curl http://your-bridge:8080/whoami -H "Authorization: Bearer <tenant-bridge-token>"
# → {"companyId":"..."}
```

## Getting a Paperclip machine API key

A session cookie expires mid-wake and is tied to a person — don't use it in production. Issue a machine bearer instead:

1. As an admin in Paperclip, open **Settings → Access claims** (or `https://<your-paperclip>/api/access/claims/new`).
2. Create a claim with `read:skills` and `read:agents` scopes.
3. Copy the bearer and set it as `PAPERCLIP_API_KEY` on the bridge.
4. Rotate any time by issuing a new claim and replacing the env var.

## Deploying when Paperclip and Hermes are on different hosts

The bridge usually lives next to Hermes. Put Traefik (or Caddy / nginx) in front so the bridge gets a public HTTPS hostname:

```yaml
services:
  paperclip-skills-bridge:
    image: ghcr.io/felipefontoura/paperclip-skills-bridge:0.1.0
    restart: unless-stopped
    environment:
      PAPERCLIP_URL: https://paperclip.example.com
      PAPERCLIP_COMPANY_ID: ${PAPERCLIP_COMPANY_ID}
      PAPERCLIP_API_KEY: ${PAPERCLIP_API_KEY}
      BRIDGE_AUTH_TOKEN: ${BRIDGE_AUTH_TOKEN}
    networks: [edge]
    labels:
      - traefik.enable=true
      - traefik.http.routers.bridge.rule=Host(`skills.example.com`)
      - traefik.http.routers.bridge.entrypoints=websecure
      - traefik.http.routers.bridge.tls.certresolver=le
      - traefik.http.services.bridge.loadbalancer.server.port=8080
      # Edge rate-limit on top of the bridge's own per-IP rate-limit.
      - traefik.http.routers.bridge.middlewares=bridge-ratelimit
      - traefik.http.middlewares.bridge-ratelimit.ratelimit.average=5
      - traefik.http.middlewares.bridge-ratelimit.ratelimit.burst=20

networks:
  edge:
    external: true
```

In the Paperclip agent's **Environment variables**, set:

| Key | Value |
|---|---|
| `SKILLS_BRIDGE_URL` | `https://skills.example.com` |
| `SKILLS_BRIDGE_TOKEN` | `${BRIDGE_AUTH_TOKEN}` (or the per-tenant token) |

Sanity checklist:

- `curl https://skills.example.com/health` returns `{"ok":true}` from anywhere.
- `curl https://skills.example.com/whoami -H "Authorization: Bearer …"` returns the right `companyId`.
- `BRIDGE_AUTH_TOKEN` matches between the bridge and the agent.
- `PAPERCLIP_API_KEY` is a machine token, not a user session cookie.

## Built-in security

- Bearer required for everything except `/health`, with constant-time comparison.
- Path traversal rejected at two layers (raw URL hook + route validator).
- Per-IP rate limit, `bodyLimit` 1 MiB, outbound `AbortSignal.timeout(5s)`.
- Logs scrub `Authorization`, `Cookie` and known token shapes; error responses are generic.
- File allowlist: only files declared in a skill's `fileInventory` are served, even if Paperclip has more on disk.

## Roadmap

- **v0.1.0** — Stateless bridge, ETag passthrough, `references/` support, inventory allowlist, multi-tenant via `BRIDGE_TENANTS`, `/whoami`, Traefik example.
- **v0.2.0** — Short-TTL cache for the index, secret-manager loader hook, structured tracing.
- **v0.3.0** — Pluggable backend for skill sources other than Paperclip.

## License

MIT — see [LICENSE](LICENSE).
