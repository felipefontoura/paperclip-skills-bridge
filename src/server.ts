#!/usr/bin/env node
// paperclip-skills-bridge — stateless HTTP shim translating Paperclip skills
// (via the Paperclip HTTP API) into the .well-known/skills protocol that
// the Hermes Agent's `WellKnownSkillSource` consumes natively.
//
// Paperclip remains the single source of truth for skills (catalog, edits,
// per-agent desired list); the bridge never caches state.

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const PAPERCLIP_URL = process.env.PAPERCLIP_URL ?? "http://paperclip:3100";
const BRIDGE_PORT = envInt("BRIDGE_PORT", 8080, 1, 65535);
const BRIDGE_HOST = process.env.BRIDGE_HOST ?? "0.0.0.0";

const PAPERCLIP_FETCH_TIMEOUT_MS = envInt("PAPERCLIP_FETCH_TIMEOUT_MS", 5000, 500, 60_000);
const BODY_LIMIT_BYTES = envInt("BRIDGE_BODY_LIMIT", 1_048_576, 16_384, 8_388_608);
const RATE_LIMIT_MAX = envInt("BRIDGE_RATE_LIMIT_MAX", 100, 1, 10_000);
const RATE_LIMIT_WINDOW_MS = envInt("BRIDGE_RATE_LIMIT_WINDOW_MS", 60_000, 1_000, 3_600_000);

// ---------------------------------------------------------------------------
// Tenant configuration
// ---------------------------------------------------------------------------
// A tenant is the unit of isolation: one Paperclip company served by the
// bridge. Each tenant carries:
//   - `companyId`       — the Paperclip company UUID we hit upstream.
//   - `bridgeToken`     — the bearer the caller must present to access this tenant.
//   - `paperclipApiKey` — machine bearer for Paperclip (preferred).
//   - `paperclipSessionCookie` — dev-only fallback cookie.
//
// Two configuration paths are supported:
//
// 1) **Multi-tenant** via `BRIDGE_TENANTS` (JSON):
//        BRIDGE_TENANTS='[
//          {"companyId":"uuid-a","bridgeToken":"tok-a","paperclipApiKey":"bear-a"},
//          {"companyId":"uuid-b","bridgeToken":"tok-b","paperclipApiKey":"bear-b"}
//        ]'
//    Each request must use `/companies/<companyId>/.well-known/skills/...`.
//
// 2) **Single-tenant (legacy)** via individual env vars:
//        PAPERCLIP_COMPANY_ID, BRIDGE_AUTH_TOKEN,
//        PAPERCLIP_API_KEY or PAPERCLIP_SESSION_COOKIE.
//    Legacy `/.well-known/skills/...` route remains available in this mode.
//
// `BRIDGE_TENANTS` wins when both are provided. The single-tenant route is
// only mounted when exactly one tenant is configured AND the legacy vars
// were the source — preserving the v0.1.0 URL shape for existing deployments.
//
// For >~10 tenants, replace `BRIDGE_TENANTS` with a startup-time fetch from a
// secret manager (1Password / Vault / SOPS / AWS Secrets Manager) — the
// `loadTenants()` function is the single extension point.

interface BridgeTenant {
  companyId: string;
  bridgeToken: string;
  paperclipApiKey?: string;
  paperclipSessionCookie?: string;
}

interface TenantsConfig {
  tenants: BridgeTenant[];
  legacyMode: boolean;      // true → mount the legacy single-tenant routes too
  openMode: boolean;        // true → no tokens configured anywhere (dev only)
}

function loadTenants(): TenantsConfig {
  // (1) BRIDGE_TENANTS JSON wins if present.
  const raw = process.env.BRIDGE_TENANTS;
  if (raw && raw.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (e: any) {
      console.error("[bridge] BRIDGE_TENANTS is not valid JSON:", e?.message);
      process.exit(1);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.error("[bridge] BRIDGE_TENANTS must be a non-empty JSON array");
      process.exit(1);
    }
    const tenants: BridgeTenant[] = [];
    for (const [i, entry] of parsed.entries()) {
      if (!entry || typeof entry !== "object") {
        console.error(`[bridge] BRIDGE_TENANTS[${i}] is not an object`);
        process.exit(1);
      }
      const t = entry as Record<string, unknown>;
      const companyId = typeof t.companyId === "string" ? t.companyId.trim() : "";
      const bridgeToken = typeof t.bridgeToken === "string" ? t.bridgeToken.trim() : "";
      const paperclipApiKey = typeof t.paperclipApiKey === "string" ? t.paperclipApiKey.trim() : undefined;
      const paperclipSessionCookie = typeof t.paperclipSessionCookie === "string" ? t.paperclipSessionCookie.trim() : undefined;
      if (!companyId || !bridgeToken) {
        console.error(`[bridge] BRIDGE_TENANTS[${i}] is missing companyId or bridgeToken`);
        process.exit(1);
      }
      if (!paperclipApiKey && !paperclipSessionCookie) {
        console.error(`[bridge] BRIDGE_TENANTS[${i}] (companyId=${companyId}) requires paperclipApiKey or paperclipSessionCookie`);
        process.exit(1);
      }
      tenants.push({ companyId, bridgeToken, paperclipApiKey, paperclipSessionCookie });
    }
    // Reject duplicate companyId or duplicate bridgeToken (silent ambiguity is bad).
    const seenCompany = new Set<string>();
    const seenToken = new Set<string>();
    for (const t of tenants) {
      if (seenCompany.has(t.companyId)) {
        console.error(`[bridge] BRIDGE_TENANTS has duplicate companyId ${t.companyId}`);
        process.exit(1);
      }
      seenCompany.add(t.companyId);
      if (seenToken.has(t.bridgeToken)) {
        console.error(`[bridge] BRIDGE_TENANTS has duplicate bridgeToken (companyId=${t.companyId}) — token collisions break auth`);
        process.exit(1);
      }
      seenToken.add(t.bridgeToken);
    }
    return { tenants, legacyMode: false, openMode: false };
  }

  // (2) Legacy single-tenant env vars.
  const legacyCompanyId = process.env.PAPERCLIP_COMPANY_ID;
  const legacyApiKey = process.env.PAPERCLIP_API_KEY;
  const legacyCookie = process.env.PAPERCLIP_SESSION_COOKIE;
  const legacyBridgeToken = process.env.BRIDGE_AUTH_TOKEN;
  if (legacyCompanyId) {
    if (!legacyApiKey && !legacyCookie) {
      console.error("[bridge] legacy mode: either PAPERCLIP_SESSION_COOKIE or PAPERCLIP_API_KEY must be set");
      process.exit(1);
    }
    const openMode = !legacyBridgeToken;
    if (openMode) {
      console.warn("[bridge] BRIDGE_AUTH_TOKEN is not set — running in OPEN mode (dev only; never expose this to the public network)");
    }
    return {
      tenants: [{
        companyId: legacyCompanyId,
        // In open mode we synthesize an unguessable internal token; auth is a no-op below.
        bridgeToken: legacyBridgeToken ?? "__open_mode__",
        paperclipApiKey: legacyApiKey,
        paperclipSessionCookie: legacyCookie,
      }],
      legacyMode: true,
      openMode,
    };
  }

  console.error("[bridge] no tenant configuration found — set either BRIDGE_TENANTS (multi-tenant) or PAPERCLIP_COMPANY_ID + PAPERCLIP_API_KEY/COOKIE + BRIDGE_AUTH_TOKEN (legacy)");
  process.exit(1);
}

const tenantsConfig = loadTenants();
const tenantByCompany: Map<string, BridgeTenant> = new Map(
  tenantsConfig.tenants.map(t => [t.companyId, t])
);

// ---------------------------------------------------------------------------
// Param validation — block path-traversal and weird names
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/;
const COMPANY_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function isSafeSlug(s: unknown): s is string {
  return typeof s === "string" && SLUG_RE.test(s);
}
function isSafeCompanyId(s: unknown): s is string {
  return typeof s === "string" && COMPANY_ID_RE.test(s);
}

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function isSafeFilePath(s: unknown): s is string {
  if (typeof s !== "string" || s.length === 0 || s.length > 256) return false;
  if (s.startsWith("/") || s.includes("\\")) return false;
  if (s.includes("%") || s.includes("\0")) return false;
  if (!s.toLowerCase().endsWith(".md")) return false;
  const segments = s.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return false;
    if (!SEGMENT_RE.test(seg)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Paperclip HTTP client (per-tenant credentials)
// ---------------------------------------------------------------------------

interface PaperclipSkill {
  id: string;
  key: string;
  slug: string;
  name: string;
  description: string | null;
  sourceType: string;
  sourceLocator: string;
  fileInventory: Array<{ path: string; kind: string }>;
  markdown?: string;
}

function paperclipHeaders(tenant: BridgeTenant): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (tenant.paperclipApiKey) {
    h.Authorization = `Bearer ${tenant.paperclipApiKey}`;
  } else if (tenant.paperclipSessionCookie) {
    h.Cookie = tenant.paperclipSessionCookie;
  }
  return h;
}

async function paperclipGet(tenant: BridgeTenant, pathSuffix: string, extraHeaders?: Record<string, string>): Promise<Response> {
  const url = `${PAPERCLIP_URL.replace(/\/+$/, "")}${pathSuffix}`;
  return fetch(url, {
    headers: { ...paperclipHeaders(tenant), ...(extraHeaders ?? {}) },
    signal: AbortSignal.timeout(PAPERCLIP_FETCH_TIMEOUT_MS),
  });
}

async function listSkills(tenant: BridgeTenant): Promise<PaperclipSkill[]> {
  const r = await paperclipGet(tenant, `/api/companies/${tenant.companyId}/skills`);
  if (!r.ok) throw new Error(`Paperclip skills list HTTP ${r.status}`);
  return (await r.json()) as PaperclipSkill[];
}

async function findSkillBySlug(tenant: BridgeTenant, slug: string): Promise<PaperclipSkill | undefined> {
  const all = await listSkills(tenant);
  return all.find(s => s.slug === slug || s.name === slug);
}

interface PaperclipSkillFile {
  skillId: string;
  path: string;
  kind: string;
  content: string;
  language?: string;
  markdown?: boolean;
  editable?: boolean;
}

interface FetchSkillFileResult {
  status: 200 | 304 | 404;
  etag?: string | null;
  body?: PaperclipSkillFile;
}

async function fetchSkillFile(tenant: BridgeTenant, skillId: string, relPath: string, ifNoneMatch?: string | null): Promise<FetchSkillFileResult> {
  const encoded = encodeURIComponent(relPath);
  const extra: Record<string, string> = {};
  if (ifNoneMatch) extra["If-None-Match"] = ifNoneMatch;
  const r = await paperclipGet(tenant, `/api/companies/${tenant.companyId}/skills/${skillId}/files?path=${encoded}`, extra);
  if (r.status === 404) return { status: 404 };
  if (r.status === 304) return { status: 304, etag: r.headers.get("etag") };
  if (!r.ok) throw new Error(`Paperclip skill file HTTP ${r.status}`);
  const body = (await r.json()) as PaperclipSkillFile;
  return { status: 200, etag: r.headers.get("etag"), body };
}

// ---------------------------------------------------------------------------
// Fastify app
// ---------------------------------------------------------------------------

const app = Fastify({
  bodyLimit: BODY_LIMIT_BYTES,
  logger: {
    level: process.env.BRIDGE_LOG_LEVEL ?? "info",
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'err.config.headers.Authorization',
        'err.config.headers.Cookie',
        'err.response.headers.authorization',
      ],
      remove: true,
    },
  },
});

await app.register(rateLimit, {
  max: RATE_LIMIT_MAX,
  timeWindow: RATE_LIMIT_WINDOW_MS,
  allowList: (req) => req.url === "/health",
  keyGenerator: (req) => req.ip,
});

app.addHook("onSend", async (_req, reply, payload) => {
  reply.header("Cache-Control", "no-store");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  return payload;
});

const RAW_PATH_TRAVERSAL_RE = /(?:^|\/)(?:\.\.|\.)(?:\/|$)|\/\//;
app.addHook("onRequest", async (req, reply) => {
  const raw = req.raw.url ?? "";
  const pathOnly = raw.split("?", 1)[0];
  if (RAW_PATH_TRAVERSAL_RE.test(pathOnly)) {
    reply.code(400).send({ error: "invalid path" });
    return reply;
  }
});

/**
 * Authenticate the caller and resolve which tenant they are speaking for.
 * Returns the matched tenant, or null after sending a 401/403.
 *
 * Identity model:
 *   - bearer ↔ tenant is a 1:1 mapping (loadTenants enforces token uniqueness)
 *   - if `expectedCompanyId` is provided, the matched tenant's companyId MUST equal it
 *     (otherwise we send 403, never 401 — distinguishes "wrong tenant" from "no auth")
 *   - timing-safe compare against every tenant token; safe up to a few hundred tenants
 */
function authenticate(req: FastifyRequest, reply: FastifyReply, expectedCompanyId: string | null): BridgeTenant | null {
  if (tenantsConfig.openMode) {
    // Legacy open dev mode: single tenant, no token required.
    return tenantsConfig.tenants[0]!;
  }
  const h = req.headers.authorization;
  if (typeof h !== "string" || !h.startsWith("Bearer ")) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  const presented = h.slice("Bearer ".length).trim();
  let match: BridgeTenant | null = null;
  for (const t of tenantsConfig.tenants) {
    if (presented.length !== t.bridgeToken.length) continue;
    let diff = 0;
    for (let i = 0; i < presented.length; i++) {
      diff |= presented.charCodeAt(i) ^ t.bridgeToken.charCodeAt(i);
    }
    if (diff === 0) { match = t; break; }
  }
  if (!match) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  if (expectedCompanyId && match.companyId !== expectedCompanyId) {
    reply.code(403).send({ error: "token is not valid for this company" });
    return null;
  }
  return match;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/health", async () => ({ ok: true }));

// `/whoami` — given a valid bearer, returns the tenant identity. Useful for
// operators who need to know which Paperclip company a token maps to (UUIDs
// never appear in the Paperclip UI). Requires auth so it can't be abused as
// a tenant enumerator from outside.
app.get("/whoami", async (req, reply) => {
  const tenant = authenticate(req, reply, null);
  if (!tenant) return;
  return { companyId: tenant.companyId };
});

/** Serialize the tenant's skill catalog into the .well-known/skills protocol. */
async function handleIndexJson(tenant: BridgeTenant, reply: FastifyReply): Promise<unknown> {
  try {
    const skills = await listSkills(tenant);
    const out = skills.map(s => {
      const files = (s.fileInventory ?? []).map(f => f.path).filter(p => /\.md$/i.test(p));
      return {
        name: s.slug ?? s.name,
        description: s.description ?? "",
        files: files.length > 0 ? files : ["SKILL.md"],
      };
    });
    return { skills: out };
  } catch (err: any) {
    app.log.error({ msg: err?.message, code: err?.code, company_id: tenant.companyId }, "index.json failed");
    reply.code(502).send({ error: "upstream paperclip error" });
    return;
  }
}

/** Serve one file from a skill, honoring fileInventory allowlist + ETag passthrough. */
async function handleSkillFile(
  tenant: BridgeTenant,
  req: FastifyRequest,
  reply: FastifyReply,
  rawSlug: string,
  rawFile: string,
): Promise<unknown> {
  if (!isSafeSlug(rawSlug)) {
    reply.code(400).send({ error: "invalid skill name" });
    return;
  }
  if (!isSafeFilePath(rawFile)) {
    reply.code(400).send({ error: "invalid file path" });
    return;
  }
  try {
    const skill = await findSkillBySlug(tenant, rawSlug);
    if (!skill) {
      reply.code(404).send({ error: "skill not found" });
      return;
    }
    const declaredPaths = new Set<string>(
      (skill.fileInventory ?? []).map(f => f?.path).filter((p): p is string => typeof p === "string")
    );
    const isDeclared = rawFile === "SKILL.md" || declaredPaths.has(rawFile);
    if (!isDeclared) {
      reply.code(404).send({ error: "file is not part of this skill's inventory" });
      return;
    }
    const inm = req.headers["if-none-match"];
    const ifNoneMatch = Array.isArray(inm) ? inm[0] : inm;
    const result = await fetchSkillFile(tenant, skill.id, rawFile, ifNoneMatch ?? null);
    if (result.status === 404) {
      reply.code(404).send({ error: "file not found in skill" });
      return;
    }
    if (result.status === 304) {
      if (result.etag) reply.header("ETag", result.etag);
      reply.code(304).send();
      return;
    }
    const body = result.body!;
    if (result.etag) reply.header("ETag", result.etag);
    reply.type("text/markdown; charset=utf-8").send(body.content ?? "");
  } catch (err: any) {
    app.log.error({ msg: err?.message, code: err?.code, company_id: tenant.companyId, slug: rawSlug, file: rawFile }, "skill file failed");
    reply.code(502).send({ error: "upstream paperclip error" });
  }
}

// --- Multi-tenant routes (always mounted) ---

app.get<{ Params: { companyId: string } }>(
  "/companies/:companyId/.well-known/skills/index.json",
  async (req, reply) => {
    const { companyId } = req.params;
    if (!isSafeCompanyId(companyId)) {
      reply.code(400).send({ error: "invalid company id" });
      return;
    }
    const tenant = authenticate(req, reply, companyId);
    if (!tenant) return;
    return handleIndexJson(tenant, reply);
  }
);

app.get<{ Params: { companyId: string; name: string; "*": string } }>(
  "/companies/:companyId/.well-known/skills/:name/*",
  async (req, reply) => {
    const { companyId, name } = req.params;
    const file = req.params["*"];
    if (!isSafeCompanyId(companyId)) {
      reply.code(400).send({ error: "invalid company id" });
      return;
    }
    const tenant = authenticate(req, reply, companyId);
    if (!tenant) return;
    return handleSkillFile(tenant, req, reply, name, file);
  }
);

// --- Legacy single-tenant routes (only when configured via legacy env vars) ---

if (tenantsConfig.legacyMode) {
  app.get("/.well-known/skills/index.json", async (req, reply) => {
    const tenant = authenticate(req, reply, null);
    if (!tenant) return;
    return handleIndexJson(tenant, reply);
  });

  app.get<{ Params: { name: string; "*": string } }>(
    "/.well-known/skills/:name/*",
    async (req, reply) => {
      const tenant = authenticate(req, reply, null);
      if (!tenant) return;
      return handleSkillFile(tenant, req, reply, req.params.name, req.params["*"]);
    }
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const start = async () => {
  try {
    await app.listen({ port: BRIDGE_PORT, host: BRIDGE_HOST });
    app.log.info({
      paperclip_url: PAPERCLIP_URL,
      tenants: tenantsConfig.tenants.length,
      mode: tenantsConfig.legacyMode ? (tenantsConfig.openMode ? "legacy-open (DEV)" : "legacy-single") : "multi-tenant",
      paperclip_fetch_timeout_ms: PAPERCLIP_FETCH_TIMEOUT_MS,
      rate_limit: `${RATE_LIMIT_MAX} req / ${RATE_LIMIT_WINDOW_MS}ms`,
    }, "paperclip-skills-bridge ready");
  } catch (err: any) {
    app.log.error({ msg: err?.message, code: err?.code }, "bridge failed to start");
    process.exit(1);
  }
};

start();

// `tenantByCompany` exposed for future extension points (cache key, metrics).
export { tenantByCompany };
