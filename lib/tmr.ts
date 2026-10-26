/**
 * Two Minute Reports REST client.
 *
 * The REST docs could not be reached from the build sandbox, so the endpoint is discovered
 * (resolveQueryPath) and the body follows the format Two Minutes stores for dashboard widget
 * queries (buildBody). `npm run tmr:probe` checks the whole setup against the real API.
 */

export type TmrFilter = {
  filterField: string;
  operator: "equals" | "notEquals" | "contains" | "notContains" | "greaterThan" | "lesserThan";
  expression: string;
};

export type TmrQuery = {
  dateRange: { startDate: string; endDate: string };
  dimensions: string[];
  metrics: string[];
  filters?: TmrFilter[];
  reportParams?: Record<string, unknown>;
};

export type TmrRequest = {
  connectorId: string;
  accountIds: string[];
  title: string;
  query: TmrQuery;
};

/** A result table with columns keyed by the requested field ids (dimensions, then metrics). */
export type TmrTable = { fields: string[]; rows: unknown[][] };

export class TmrError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "TmrError";
  }
}

export type TmrConfig = {
  apiKey: string;
  teamId: string;
  baseUrl: string;
  queryPath: string;
  /** Prefix added to every field id, e.g. "fads_" if the REST API wants connector-prefixed ids. */
  fieldPrefix: string;
  timeoutMs: number;
  retries: number;
  backoffMs: number;
  /** Minimum gap between request starts; Two Minutes sits behind a Cloudflare rate limit. */
  minIntervalMs: number;
  /** Waits before giving up on a 429 (Retry-After wins when the server sends one). */
  rateLimitWaitsMs: number[];
};

export function configFromEnv(env = process.env): TmrConfig {
  const apiKey = env.TMR_API_KEY ?? "";
  if (!apiKey) throw new TmrError("TMR_API_KEY is not set");
  return {
    apiKey,
    teamId: env.TMR_TEAM_ID || "019d0ca3-ce95-7387-a650-5e055605107a",
    baseUrl: (env.TMR_API_BASE || "https://api.twominutereports.com/v1").replace(/\/$/, ""),
    queryPath: env.TMR_QUERY_PATH || "/teams/{teamId}/query",
    fieldPrefix: env.TMR_FIELD_PREFIX || "",
    timeoutMs: Number(env.TMR_TIMEOUT_MS || 120_000),
    retries: 3,
    backoffMs: 2_000,
    minIntervalMs: Number(env.TMR_MIN_INTERVAL_MS || 2_000),
    rateLimitWaitsMs: [30_000, 60_000, 120_000, 240_000],
  };
}

/** Connector prefix for field ids: TMR_FIELD_PREFIX, or "<connectorId>_" by default ("none" turns it off). */
function fieldPrefixFor(cfg: Pick<TmrConfig, "fieldPrefix">, connectorId: string): string {
  if (cfg.fieldPrefix === "none") return "";
  return cfg.fieldPrefix || `${connectorId}_`;
}

/**
 * REST run-query body. Mirrors how Two Minutes stores dashboard widget queries:
 * accounts and every field carry the connector prefix ("fads_act_123", "fads_spend"),
 * and Facebook options go in fadsOptions. Keys whose exact REST spelling is unconfirmed
 * (date range, currency, filter fields) are sent in both likely forms; the API's validator
 * reports missing keys and ignores ones it doesn't know.
 */
export function buildBody(cfg: Pick<TmrConfig, "teamId" | "fieldPrefix">, req: TmrRequest) {
  const fp = fieldPrefixFor(cfg, req.connectorId);
  const p = (f: string) => (f.startsWith(fp) ? f : fp + f);
  const { dateRange, reportParams } = req.query;
  return {
    teamId: cfg.teamId,
    title: req.title,
    accounts: req.accountIds.map((a) => (a.startsWith(`${req.connectorId}_`) ? a : `${req.connectorId}_${a}`)),
    metrics: req.query.metrics.map(p),
    dimensions: req.query.dimensions.map(p),
    filters: (req.query.filters ?? []).map((f) => ({
      fieldId: p(f.filterField),
      field: p(f.filterField),
      filterField: p(f.filterField),
      operator: f.operator,
      expression: f.expression,
      value: f.expression,
      ruleType: "and",
    })),
    sortBy: [],
    dateRange,
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    ...(reportParams ? { [`${req.connectorId}Options`]: reportParams, reportParams } : {}),
  };
}

export function queryUrl(cfg: Pick<TmrConfig, "baseUrl" | "queryPath" | "teamId">): string {
  return cfg.baseUrl + cfg.queryPath.replace("{teamId}", encodeURIComponent(cfg.teamId));
}

type Found = { headers?: unknown[]; rows: unknown[] };

/** Depth-first search for the result table: an object with a `rows` array, or an array of row objects. */
function findTable(node: unknown, depth = 0): Found | null {
  if (depth > 5 || node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    if (node.length && node.every((r) => r && typeof r === "object" && !Array.isArray(r) && !("rows" in r) && !("data" in r) && !("results" in r))) {
      return { rows: node };
    }
    for (const child of node) {
      const t = findTable(child, depth + 1);
      if (t) return t;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.rows)) return { headers: Array.isArray(obj.headers) ? obj.headers : undefined, rows: obj.rows };
  for (const key of ["data", "result", "results", "connectorResults"]) {
    if (key in obj) {
      const t = findTable(obj[key], depth + 1);
      if (t) return t;
    }
  }
  if (Array.isArray(obj.data) && obj.data.length === 0) return { rows: [] };
  return null;
}

/**
 * Pull the result table out of a run-query response and return rows as arrays in the order
 * of the requested fields (dimensions, then metrics). Handles header+row arrays (headers may be
 * display labels, so columns map by position unless the headers are field ids) and rows as objects
 * keyed by field id, with or without the connector prefix.
 */
export function extractTable(json: unknown, req: Pick<TmrRequest, "query"> & { connectorId?: string }): TmrTable {
  const root = json as Record<string, any>;
  if (root?.success === false || (root?.error && !root?.data)) {
    throw new TmrError(`TMR query error: ${stringify(root.error ?? root).slice(0, 400)}`);
  }
  for (const c of root?.connectorResults ?? root?.data?.connectorResults ?? []) {
    if (c?.error) throw new TmrError(`TMR connector error: ${stringify(c.error)}`);
    for (const r of c?.results ?? []) if (r?.error) throw new TmrError(`TMR query error: ${stringify(r.error)}`);
  }
  const fields = [...req.query.dimensions, ...req.query.metrics];
  const found = findTable(json);
  if (!found) throw new TmrError(`Unexpected TMR response shape: ${stringify(json).slice(0, 400)}`);
  if (!found.rows.length) return { fields, rows: [] };

  const prefix = req.connectorId ? `${req.connectorId}_` : "";
  const keyFor = (keys: string[], f: string) => {
    const wanted = [f, prefix + f].map((k) => k.toLowerCase());
    return keys.find((k) => wanted.includes(k.toLowerCase()));
  };

  if (Array.isArray(found.rows[0])) {
    const headers = (found.headers ?? []).map(String);
    // Field-id headers (any order): reorder to the requested fields.
    const idx = fields.map((f) => (headers.length ? headers.indexOf(keyFor(headers, f) ?? "\0") : -1));
    if (idx.every((i) => i >= 0)) return { fields, rows: (found.rows as unknown[][]).map((r) => idx.map((i) => r[i])) };
    // Display-label headers: positional.
    if (headers.length && headers.length !== fields.length) {
      throw new TmrError(`TMR returned ${headers.length} columns for ${fields.length} requested fields: ${headers.join(", ")}`);
    }
    return { fields, rows: found.rows as unknown[][] };
  }

  // Object rows leave out empty fields, so look across every row; a metric that never appears is
  // empty for the whole range (e.g. Brand purchase fields when only CPAS accounts bought).
  const keys = [...new Set(found.rows.flatMap((r) => Object.keys(r as object)))];
  const map = fields.map((f) => keyFor(keys, f));
  const missingDims = req.query.dimensions.filter((f) => !map[fields.indexOf(f)]);
  if (missingDims.length) {
    throw new TmrError(`TMR rows are missing dimension ${missingDims.join(", ")}; row keys: ${keys.join(", ")}`);
  }
  return {
    fields,
    rows: found.rows.map((r) => map.map((k) => (k === undefined ? null : ((r as Record<string, unknown>)[k] ?? null)))),
  };
}

function stringify(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let nextSlot = 0;

/**
 * Every call to Two Minutes goes through here: requests are spaced at least minIntervalMs apart,
 * and a 429 (Cloudflare 1015) waits Retry-After or the next rateLimitWaitsMs step, then tries again.
 * Throws a short TmrError once the waits run out.
 */
async function tmrFetch(cfg: TmrConfig, url: string, init: RequestInit, log: (msg: string) => void): Promise<Response> {
  for (let i = 0; ; i++) {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + cfg.minIntervalMs;
    if (slot > now) await sleep(slot - now);

    const res = await fetch(url, init);
    if (res.status !== 429) return res;
    await res.body?.cancel();
    if (i >= cfg.rateLimitWaitsMs.length) {
      throw new TmrError(
        `Two Minutes is rate-limiting this server (HTTP 429, Cloudflare 1015) on ${new URL(url).pathname}. ` +
          "Gave up after waiting several minutes; try Sync now again later.",
        429,
      );
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : cfg.rateLimitWaitsMs[i];
    log(`  rate-limited by Two Minutes (429), waiting ${Math.round(wait / 1000)}s`);
    nextSlot = Date.now() + wait;
  }
}

/** Likely Run query paths, tried in order when the configured one 404s. */
export const CANDIDATE_PATHS = [
  "/teams/{teamId}/query",
  "/data/query",
  "/teams/{teamId}/data/query",
  "/data/run-query",
  "/teams/{teamId}/data/run-query",
  "/data/run",
  "/teams/{teamId}/data/run",
  "/data/queries",
  "/teams/{teamId}/data/queries",
  "/teams/{teamId}/queries/run",
  "/teams/{teamId}/run-query",
  "/run-query",
  "/query",
  "/queries",
  "/data",
  "/teams/{teamId}/data",
];

const resolvedPaths = new Map<string, string>();

/** POST paths from the server's OpenAPI spec that look like Run query, if it publishes one. */
async function openApiCandidates(cfg: TmrConfig, log: (msg: string) => void): Promise<string[]> {
  const origin = new URL(cfg.baseUrl).origin;
  const basePath = new URL(cfg.baseUrl).pathname.replace(/\/$/, "");
  for (const url of [`${cfg.baseUrl}/openapi.json`, `${origin}/openapi.json`]) {
    try {
      const res = await tmrFetch(cfg, url, { headers: { Authorization: `Bearer ${cfg.apiKey}` }, signal: AbortSignal.timeout(10_000) }, log);
      if (!res.ok) continue;
      const spec = (await res.json()) as { paths?: Record<string, Record<string, { operationId?: string; summary?: string }>> };
      if (!spec?.paths) continue;
      const found = Object.entries(spec.paths)
        .filter(([path, ops]) => ops.post && /query|run/i.test(`${path} ${ops.post.operationId ?? ""} ${ops.post.summary ?? ""}`))
        .map(([path]) => (basePath && path.startsWith(basePath) ? path.slice(basePath.length) : path))
        .map((path) => path.replace(/\{[^}]*team[^}]*\}/i, "{teamId}"));
      log(`  TMR OpenAPI spec at ${url}: ${found.length ? found.join(", ") : "no run-query path"}`);
      return found;
    } catch (err) {
      if (err instanceof TmrError) throw err; // rate limit: stop probing
      // not JSON or not reachable: try the next location
    }
  }
  return [];
}

/**
 * Find the Run query endpoint: the configured TMR_QUERY_PATH, then the server's OpenAPI spec,
 * then CANDIDATE_PATHS. A tiny one-day query is sent to each; 404/405 means the route is wrong.
 * The answer is cached for the life of the process.
 */
export async function resolveQueryPath(
  req: TmrRequest,
  cfg: TmrConfig = configFromEnv(),
  log: (msg: string) => void = console.log,
): Promise<string> {
  const cacheKey = `${cfg.baseUrl}|${cfg.queryPath}`;
  const cached = resolvedPaths.get(cacheKey);
  if (cached) return cached;

  const day = req.query.dateRange.startDate;
  const probe: TmrRequest = {
    ...req,
    accountIds: req.accountIds.slice(0, 1),
    title: "endpoint check",
    query: { dateRange: { startDate: day, endDate: day }, dimensions: ["year_month"], metrics: ["spend"], reportParams: { includeAllItems: true } },
  };
  const tried = new Map<string, number>();
  const firstExisting = async (paths: string[]): Promise<string | null> => {
    for (const path of paths) {
      if (tried.has(path)) continue;
      const url = queryUrl({ ...cfg, queryPath: path });
      let res: Response;
      try {
        res = await tmrFetch(cfg, url, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(buildBody(cfg, probe)),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        }, log);
      } catch (err) {
        if (err instanceof TmrError) throw err;
        throw new TmrError(`Could not reach Two Minutes at ${url}: ${(err as Error).message}`, undefined, true);
      }
      const text = (await res.text()).slice(0, 200);
      if (res.status === 401 || res.status === 403) {
        throw new TmrError(`TMR ${res.status}: the API key was rejected. Use an API key (not MCP) with scope data:read. ${text}`, res.status);
      }
      tried.set(path, res.status);
      // 404/405 = no such route. A real answer (200, 400, 422...) means the route exists.
      // 5xx proves nothing either way, so it is not accepted.
      if (res.status !== 404 && res.status !== 405 && res.status < 500) {
        log(`  TMR endpoint check: POST ${path} -> HTTP ${res.status}`);
        return path;
      }
    }
    return null;
  };

  let path = await firstExisting([cfg.queryPath]);
  if (!path) {
    path = await firstExisting([...(await openApiCandidates(cfg, log)), ...CANDIDATE_PATHS]);
    if (path) log(`  TMR Run query endpoint found: ${path}. Set TMR_QUERY_PATH=${path} to skip this check.`);
  }
  if (!path) {
    throw new TmrError(
      `Could not find the Two Minutes Run query endpoint under ${cfg.baseUrl}. Tried (HTTP status): ` +
        `${[...tried].map(([p, st]) => `${p} ${st}`).join(", ")}. Set TMR_QUERY_PATH to the path on the docs' Data > Run query page.`,
    );
  }
  resolvedPaths.set(cacheKey, path);
  return path;
}

export async function runQuery(
  req: TmrRequest,
  cfg: TmrConfig = configFromEnv(),
  log: (msg: string) => void = console.log,
): Promise<TmrTable> {
  const queryPath = await resolveQueryPath(req, cfg, log);
  if (!cfg.fieldPrefix && rawFieldIds.has(cfg.baseUrl)) cfg = { ...cfg, fieldPrefix: "none" };
  try {
    return await runQueryAt(queryPath, req, cfg, log);
  } catch (err) {
    // Prefixed field ids rejected (e.g. "Unknown metric fads_spend"): retry once with raw ids and remember.
    const msg = (err as Error).message.split(" (body keys sent")[0];
    if (!cfg.fieldPrefix && err instanceof TmrError && err.status === 400 && msg.includes(`${req.connectorId}_`) && !/accounts/i.test(msg)) {
      log(`  prefixed field ids rejected (${msg.slice(0, 160)}); retrying with raw ids`);
      const table = await runQueryAt(queryPath, req, { ...cfg, fieldPrefix: "none" }, log);
      rawFieldIds.add(cfg.baseUrl);
      return table;
    }
    throw err;
  }
}

const rawFieldIds = new Set<string>();

async function runQueryAt(queryPath: string, req: TmrRequest, cfg: TmrConfig, log: (msg: string) => void): Promise<TmrTable> {
  const url = queryUrl({ ...cfg, queryPath });
  const body = JSON.stringify(buildBody(cfg, req));
  let lastErr: unknown;
  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    if (attempt > 0) {
      const wait = cfg.backoffMs * 2 ** (attempt - 1);
      log(`  retry ${attempt}/${cfg.retries} in ${wait / 1000}s (${(lastErr as Error)?.message})`);
      await sleep(wait);
    }
    const started = Date.now();
    try {
      const res = await tmrFetch(cfg, url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      }, log);
      const text = await res.text();
      if (!res.ok) {
        const sent = res.status === 400 ? ` (body keys sent: ${Object.keys(JSON.parse(body)).join(", ")})` : "";
        throw new TmrError(`TMR ${res.status} on POST ${queryPath}: ${text.slice(0, 400)}${sent}`, res.status, res.status >= 500);
      }
      const table = extractTable(JSON.parse(text), req);
      log(`  ${req.title} ${req.query.dateRange.startDate}..${req.query.dateRange.endDate}: ${table.rows.length} rows in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return table;
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err;
    }
  }
  throw lastErr;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof TmrError) return err.retryable;
  const name = (err as Error)?.name;
  // AbortSignal.timeout -> TimeoutError; network drops -> TypeError("fetch failed")
  return name === "TimeoutError" || name === "AbortError" || name === "TypeError";
}
