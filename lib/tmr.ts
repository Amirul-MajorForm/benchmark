/**
 * Two Minute Reports REST client.
 *
 * The request body mirrors the MCP `run_query` payload the prototype used
 * ({ teamId, connectors: [{ connectorId, currencyCode?, accountIds, queries: [{ title, query }] }] }).
 * Endpoint path and field naming are configurable because they could not be confirmed from
 * the build sandbox; `npm run tmr:probe` finds the working combination against the real API.
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
  currencyCode?: string;
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
  };
}

export function buildBody(cfg: Pick<TmrConfig, "teamId" | "fieldPrefix">, req: TmrRequest) {
  const p = (f: string) => cfg.fieldPrefix + f;
  const query = {
    ...req.query,
    dimensions: req.query.dimensions.map(p),
    metrics: req.query.metrics.map(p),
    filters: (req.query.filters ?? []).map((f) => ({ ...f, filterField: p(f.filterField) })),
  };
  return {
    teamId: cfg.teamId,
    connectors: [
      {
        connectorId: req.connectorId,
        ...(req.currencyCode ? { currencyCode: req.currencyCode } : {}),
        accountIds: req.accountIds,
        queries: [{ title: req.title, query }],
      },
    ],
  };
}

export function queryUrl(cfg: Pick<TmrConfig, "baseUrl" | "queryPath" | "teamId">): string {
  return cfg.baseUrl + cfg.queryPath.replace("{teamId}", encodeURIComponent(cfg.teamId));
}

/**
 * Pull the single result table out of a run-query response.
 * Headers come back as display labels ("Facebook Ads Amount spent"), not ids, so columns are
 * mapped by position to the fields we asked for.
 */
export function extractTable(json: unknown, req: Pick<TmrRequest, "query">): TmrTable {
  const root = json as Record<string, any>;
  const connectorResults = root?.connectorResults ?? root?.data?.connectorResults ?? root?.result?.connectorResults;
  const connector = Array.isArray(connectorResults) ? connectorResults[0] : undefined;
  if (connector?.error) throw new TmrError(`TMR connector error: ${stringify(connector.error)}`);
  const result = connector?.results?.[0];
  if (result?.error) throw new TmrError(`TMR query error: ${stringify(result.error)}`);
  const data = result?.data;
  if (!data || !Array.isArray(data.rows)) {
    throw new TmrError(`Unexpected TMR response shape: ${stringify(json).slice(0, 500)}`);
  }
  const fields = [...req.query.dimensions, ...req.query.metrics];
  const headers: unknown[] = Array.isArray(data.headers) ? data.headers : [];
  if (headers.length && headers.length !== fields.length) {
    throw new TmrError(`TMR returned ${headers.length} columns for ${fields.length} requested fields: ${headers.join(", ")}`);
  }
  return { fields, rows: data.rows };
}

function stringify(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runQuery(
  req: TmrRequest,
  cfg: TmrConfig = configFromEnv(),
  log: (msg: string) => void = console.log,
): Promise<TmrTable> {
  const url = queryUrl(cfg);
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
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new TmrError(`TMR ${res.status} ${res.statusText}: ${text.slice(0, 500)}`, res.status, res.status >= 500 || res.status === 429);
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
