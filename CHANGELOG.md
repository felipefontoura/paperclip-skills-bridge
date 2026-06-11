# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-11

Initial release.

### Added
- Stateless HTTP shim that translates Paperclip's company-skills API into the `.well-known/skills/` protocol Hermes Agent's `WellKnownSkillSource` already consumes.
- Multi-tenant mode via `BRIDGE_TENANTS` JSON (one entry per Paperclip company) — each request to `/companies/<id>/.well-known/skills/...` must present a bearer that maps to `<id>`. Cross-tenant attempts return 403, unauthenticated 401.
- Backward-compatible single-tenant mode via `PAPERCLIP_COMPANY_ID` + `PAPERCLIP_API_KEY` + `BRIDGE_AUTH_TOKEN`; legacy `/.well-known/skills/...` routes stay mounted in this mode.
- `/whoami` endpoint that returns the `companyId` for a presented bearer — helpful for finding the UUID that Paperclip never shows in its UI.
- Inventory allowlist: only files explicitly listed in a skill's `fileInventory` are served, even if Paperclip happens to expose more on disk.
- ETag passthrough between Hermes and Paperclip so unchanged content costs only headers.
- Per-IP rate limit (`@fastify/rate-limit`), bounded body size, bounded outbound timeouts, all clamped via env.

### Security
- Constant-time bearer comparison.
- Path traversal rejected at two layers: an `onRequest` hook inspects `req.raw.url` (catches raw-socket attackers that don't normalize `../`), and per-route validators reject suspicious slugs / file paths.
- Pino logs scrub `Authorization`, `Cookie`, `Set-Cookie` and known token shapes; errors carry `{ msg, code }` only.
- HTTP error bodies are generic (`{"error":"upstream paperclip error"}`); upstream details stay server-side.

### Documentation
- User-focused README with Docker run, Configuration reference, multi-tenant example, machine API key flow, and a Traefik-based split-domain deployment.

[Unreleased]: https://github.com/felipefontoura/paperclip-skills-bridge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/felipefontoura/paperclip-skills-bridge/releases/tag/v0.1.0
