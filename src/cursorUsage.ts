import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import initSqlJs from "sql.js";

/**
 * Cursor usage collector — the undocumented, vendor-internal part.
 *
 * ⚠️  verified: false  ⚠️
 * Cursor exposes NO public extension API for token usage. The only way to read
 * real per-user numbers is to (1) read the session token Cursor stores in its
 * local SQLite DB and (2) call Cursor's own internal usage endpoint. Both are
 * undocumented and can change without notice. This collector therefore FAILS
 * SAFE: on any locate/parse/shape mismatch it returns null and contributes
 * nothing, rather than guessing — matching the repo's "experimental collectors
 * contribute nothing rather than guessing" convention.
 *
 * Once confirmed on a real machine, flip VERIFIED to true (and update endpoint
 * details below if Cursor has changed them).
 *
 * PRIVACY: only token counts, request counts, model names, and the billing
 * period start are read. Prompts, code, file paths, and chat content are never
 * touched.
 */
export const VERIFIED = false;

export interface CursorModelUsage {
  model: string;
  tokens: number;
  requests: number;
}

export interface CursorUsageSnapshot {
  periodStart: string; // Cursor's `startOfMonth` (billing period anchor)
  models: CursorModelUsage[];
}

export type Logger = (msg: string) => void;

const SESSION_TOKEN_KEY = "cursorAuth/accessToken";

// Use the apex domain. Some networks/DNS resolve `cursor.com` but not the
// `www.` host, which surfaced in production as `fetch failed` (ENOTFOUND).
const API_BASE = "https://cursor.com";

// Node.js cannot allocate a Buffer >= 2 GiB, so fs.readFileSync (and therefore
// sql.js, which loads the whole DB into memory) throws on Cursor's larger
// state.vscdb files (seen at 6+ GiB). Above this we fall back to the system
// `sqlite3` CLI, which reads a single key without slurping the file.
const TWO_GIB = 2 * 1024 * 1024 * 1024;

/**
 * Read one ItemTable value via the system `sqlite3` CLI — the fallback for
 * databases too large for sql.js. Returns null (never throws) if sqlite3 is
 * missing or the query fails, keeping the collector's fail-safe contract.
 */
function readItemViaCli(dbPath: string, key: string, log: Logger): string | null {
  const escaped = key.replace(/'/g, "''"); // SQL single-quote escaping
  const sql = `SELECT value FROM ItemTable WHERE key = '${escaped}' LIMIT 1;`;
  try {
    const out = execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const value = out.replace(/\r?\n$/, "");
    return value.length ? value : null;
  } catch (e) {
    log(`sqlite3 CLI read failed for ${key}: ${(e as Error).message}`);
    return null;
  }
}

/** Per-platform path to Cursor's globalStorage SQLite database. */
function stateDbPath(): string | null {
  const home = os.homedir();
  switch (process.platform) {
    case "win32": {
      const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
      return path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
    }
    case "darwin":
      return path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
    case "linux":
      return path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
    default:
      return null;
  }
}

let sqlPromise: ReturnType<typeof initSqlJs> | null = null;
function getSql() {
  if (!sqlPromise) {
    // require.resolve("sql.js") returns the package main (dist/sql-wasm.js), so
    // dirname gives us the dist/ folder where sql-wasm.wasm also lives.
    const distDir = path.dirname(require.resolve("sql.js"));
    sqlPromise = initSqlJs({ locateFile: (f: string) => path.join(distDir, f) });
  }
  return sqlPromise;
}

/** Read a single value out of Cursor's ItemTable by key. */
async function readItem(dbPath: string, key: string, log: Logger): Promise<string | null> {
  let size = 0;
  try { size = fs.statSync(dbPath).size; } catch { /* fall through to readFileSync error */ }
  if (size >= TWO_GIB) {
    log(`state.vscdb is ${(size / (1024 ** 3)).toFixed(1)} GiB (>= 2 GiB) — reading via sqlite3 CLI`);
    return readItemViaCli(dbPath, key, log);
  }

  let buf: Buffer;
  try {
    buf = fs.readFileSync(dbPath); // snapshot read — safe even while Cursor holds the file
  } catch (e) {
    log(`readFileSync failed (${(e as Error).message}) — falling back to sqlite3 CLI`);
    return readItemViaCli(dbPath, key, log);
  }
  const SQL = await getSql();
  const db = new SQL.Database(buf);
  try {
    const res = db.exec("SELECT value FROM ItemTable WHERE key = :k", { ":k": key });
    const value = res?.[0]?.values?.[0]?.[0];
    return typeof value === "string" ? value : null;
  } catch (e) {
    log(`query failed for ${key}: ${(e as Error).message}`);
    return null;
  } finally {
    db.close();
  }
}

/** Log all cursorAuth/* key names (no values) for diagnostics. */
async function logCursorAuthKeys(dbPath: string, log: Logger): Promise<void> {
  let size = 0;
  try { size = fs.statSync(dbPath).size; } catch { /* ignore */ }
  if (size >= TWO_GIB) {
    const sql = "SELECT key FROM ItemTable WHERE key LIKE 'cursor%' OR key LIKE 'Cursor%';";
    try {
      const out = execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      const keys = out.split(/\r?\n/).filter(Boolean);
      log(`cursorAuth keys in DB: ${keys.join(", ") || "(none)"}`);
    } catch (e) {
      log(`key scan via sqlite3 CLI failed: ${(e as Error).message}`);
    }
    return;
  }

  let buf: Buffer;
  try { buf = fs.readFileSync(dbPath); } catch { return; }
  const SQL = await getSql();
  const db = new SQL.Database(buf);
  try {
    const res = db.exec("SELECT key FROM ItemTable WHERE key LIKE 'cursor%' OR key LIKE 'Cursor%'");
    const keys = (res?.[0]?.values ?? []).map((r) => String(r[0]));
    log(`cursorAuth keys in DB: ${keys.join(", ") || "(none)"}`);
  } catch (e) {
    log(`key scan failed: ${(e as Error).message}`);
  } finally {
    db.close();
  }
}

/** Decode a JWT payload without verifying (we only need the `sub` claim). */
function decodeJwt(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Cursor's session token `sub` looks like `user_01ABC...` (WorkOS) or
 * `auth0|user_01ABC...` / `google-oauth2|12345` (older). We always keep the
 * FULL sub for the cookie (Cursor validates against it server-side) and derive
 * a bare id (after `|`) only for the ?user= query param.
 */
function userIdFromToken(token: string): { sub: string; bareId: string } | null {
  const payload = decodeJwt(token);
  const sub = payload?.sub;
  if (typeof sub !== "string" || !sub) return null;
  const bareId = sub.includes("|") ? (sub.split("|").pop() ?? sub) : sub;
  return { sub, bareId };
}

interface RawUsageEntry {
  numRequests?: number;
  numRequestsTotal?: number;
  numTokens?: number;
}

/** The session cookie Cursor's web/dashboard endpoints expect. */
function sessionCookie(userId: string, token: string): string {
  return `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}`;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface BillingCycle {
  periodStart: string; // the anchor we hand to the store (changes each cycle)
  startMs: string; // cycle start, epoch-ms string (event filter wants ms strings)
  endMs: string; // cycle end − 1ms, epoch-ms string
}

/**
 * Resolve the current billing cycle bounds from the dashboard summary.
 * GET https://cursor.com/api/usage-summary → { billingCycleStart, billingCycleEnd }
 */
async function fetchBillingCycle(cookie: string, log: Logger): Promise<BillingCycle | null> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/usage-summary`, {
      headers: { Cookie: cookie, Accept: "application/json" },
      redirect: "follow",
    });
  } catch (e) {
    log(`usage-summary request failed: ${(e as Error).message}`);
    return null;
  }
  if (!res.ok) {
    log(`usage-summary returned ${res.status}`);
    return null;
  }
  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch (e) {
    log(`usage-summary not JSON: ${(e as Error).message}`);
    return null;
  }

  const startRaw = data.billingCycleStart ?? data.startOfMonth;
  const startMs = startRaw != null ? new Date(startRaw as string | number).getTime() : NaN;
  if (!Number.isFinite(startMs)) {
    log("usage-summary missing/unparseable billingCycleStart — contributing nothing (fail safe)");
    return null;
  }
  const endParsed = data.billingCycleEnd != null ? new Date(data.billingCycleEnd as string | number).getTime() : NaN;
  const endMs = Number.isFinite(endParsed) ? endParsed - 1 : Date.now();
  return { periodStart: String(startRaw), startMs: String(startMs), endMs: String(endMs) };
}

interface RawUsageEvent {
  model?: string;
  tokenUsage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * Modern per-event usage (token-priced Pro plans). Paginates
 * POST https://cursor.com/api/dashboard/get-filtered-usage-events over the
 * billing cycle and aggregates input+output tokens and an event count per model.
 */
async function fetchFilteredEvents(cookie: string, cycle: BillingCycle, log: Logger): Promise<CursorUsageSnapshot | null> {
  const byModel = new Map<string, { tokens: number; requests: number }>();
  const pageSize = 100;
  let events = 0;

  for (let page = 1; page <= 100; page++) {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/dashboard/get-filtered-usage-events`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Accept: "application/json",
          "Content-Type": "application/json",
          Origin: API_BASE,
        },
        redirect: "follow",
        body: JSON.stringify({ startDate: cycle.startMs, endDate: cycle.endMs, page, pageSize }),
      });
    } catch (e) {
      log(`usage-events request failed: ${(e as Error).message}`);
      break;
    }
    if (!res.ok) {
      log(`usage-events page ${page} returned ${res.status}`);
      break;
    }
    let data: Record<string, unknown>;
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch (e) {
      log(`usage-events not JSON: ${(e as Error).message}`);
      break;
    }

    const batch = (data.usageEventsDisplay ?? data.usageEvents ?? data.events ?? []) as RawUsageEvent[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const ev of batch) {
      const model = typeof ev.model === "string" && ev.model ? ev.model : "unknown";
      const input = Number(ev.tokenUsage?.inputTokens) || 0;
      const output = Number(ev.tokenUsage?.outputTokens) || 0;
      const agg = byModel.get(model) ?? { tokens: 0, requests: 0 };
      agg.tokens += input + output;
      agg.requests += 1;
      byModel.set(model, agg);
      events++;
    }
    if (batch.length < pageSize) break;
    await delay(200);
  }

  if (byModel.size === 0) {
    log("usage-events: no events this billing period");
    return null;
  }
  const models: CursorModelUsage[] = [...byModel.entries()].map(([model, a]) => ({ model, tokens: a.tokens, requests: a.requests }));
  const totalTokens = models.reduce((s, m) => s + m.tokens, 0);
  log(`usage-events: ${events} events, ${totalTokens} tokens this period`);
  return { periodStart: cycle.periodStart, models };
}

/**
 * Legacy fallback: GET https://cursor.com/api/usage?user=<id>. On modern Pro
 * plans this only carries stale gpt-4 counters (all zero), so we trust it ONLY
 * when it reports non-zero tokens — otherwise contribute nothing (fail safe).
 */
async function fetchLegacyUsage(userId: string, token: string, log: Logger): Promise<CursorUsageSnapshot | null> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/usage?user=${encodeURIComponent(userId)}`, {
      headers: { Cookie: sessionCookie(userId, token), Accept: "application/json" },
      redirect: "follow",
    });
  } catch (e) {
    log(`legacy usage request failed: ${(e as Error).message}`);
    return null;
  }
  if (!res.ok) {
    log(`legacy usage endpoint returned ${res.status}`);
    return null;
  }
  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch (e) {
    log(`legacy usage not JSON: ${(e as Error).message}`);
    return null;
  }

  const periodStart = typeof data.startOfMonth === "string" ? data.startOfMonth : null;
  const models: CursorModelUsage[] = [];
  let anyTokens = false;
  for (const [model, entry] of Object.entries(data)) {
    if (model === "startOfMonth" || entry === null || typeof entry !== "object") continue;
    const e = entry as RawUsageEntry;
    const tokens = Number.isFinite(e.numTokens) ? Number(e.numTokens) : 0;
    const requests = Number.isFinite(e.numRequests) ? Number(e.numRequests) : 0;
    if (tokens > 0) anyTokens = true;
    if (tokens === 0 && requests === 0) continue;
    models.push({ model, tokens, requests });
  }

  if (!periodStart || !anyTokens) {
    log("legacy usage has no non-zero tokens — contributing nothing (fail safe)");
    return null;
  }
  return { periodStart, models };
}

/**
 * Read real per-model usage for the current billing period. Prefers the modern
 * dashboard event stream (token-priced plans); only falls back to the legacy
 * /api/usage counters when they carry non-zero tokens.
 */
async function fetchUsage(sub: string, bareId: string, token: string, log: Logger): Promise<CursorUsageSnapshot | null> {
  // Masked for diagnostics — never log the raw token.
  log(`derived userId: ${bareId.slice(0, 8)}… (sub prefix: ${sub.slice(0, 12)}…)`);
  const cookie = sessionCookie(bareId, token);

  const cycle = await fetchBillingCycle(cookie, log);
  if (cycle) {
    const snap = await fetchFilteredEvents(cookie, cycle, log);
    if (snap) return snap;
  }
  return fetchLegacyUsage(bareId, token, log);
}

/**
 * Read the current Cursor usage snapshot, or null if anything is unavailable.
 * Never throws — every failure path logs and returns null so a sync degrades
 * gracefully instead of disrupting the editor.
 */
export async function collectCursorUsage(log: Logger): Promise<CursorUsageSnapshot | null> {
  if (!VERIFIED) {
    log(
      "Cursor collector is unverified (verified:false). It will attempt a read but " +
        "may contribute nothing until the endpoint shape is confirmed on this machine.",
    );
  }
  const dbPath = stateDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) {
    log(`Cursor state DB not found (looked at: ${dbPath ?? "unsupported platform"})`);
    return null;
  }
  await logCursorAuthKeys(dbPath, log);

  const rawToken = await readItem(dbPath, SESSION_TOKEN_KEY, log);
  // Log just enough of the raw value to know its shape (JSON object vs plain JWT vs quoted).
  log(`raw token prefix (first 20 chars): ${JSON.stringify(rawToken?.slice(0, 20) ?? null)}`);
  const token = rawToken?.replace(/^"|"$/g, "") ?? null;
  if (!token) {
    log("no Cursor session token found — are you signed in to Cursor?");
    return null;
  }
  const ids = userIdFromToken(token);
  if (!ids) {
    log("could not derive Cursor user id from session token — token may not be a JWT");
    return null;
  }
  return fetchUsage(ids.sub, ids.bareId, token, log);
}
