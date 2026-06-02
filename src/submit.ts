import * as vscode from "vscode";
import { INGEST_URL } from "./config";
import { deviceId } from "./deviceId";
import { getToken } from "./auth";
import { collectCursorUsage, type Logger } from "./cursorUsage";
import { cumulative, ingestSnapshot, loadStore, saveStore, type Store } from "./store";

const CLIENT_VERSION = "0.1.0";

export class NotLinkedError extends Error {
  code = "NOT_LINKED";
  constructor() {
    super("not linked — run “StraVIBE: Sign in” to link your account first");
  }
}

export class NoUsageError extends Error {
  code = "NO_USAGE";
  constructor() {
    super("no Cursor usage available — sign in to Cursor first (see diagnostics)");
  }
}

/**
 * Build the leaderboard request body from the persistent all-time store — the
 * same cumulative-replace contract the npm CLI uses (buildPayload in
 * stravibe-npm-package/src/submit.js), tagged as the `cursor` agent so it lands
 * in its own per-device row and ADDS to the user's total.
 */
export function buildPayload(store: Store, handle: string | null) {
  const cum = cumulative(store);
  const by_model: Record<string, { input: number; output: number; cache_read: number; cache_write: number; calls: number }> = {};
  for (const [model, m] of Object.entries(cum.byModel)) {
    by_model[model] = { input: m.input, output: m.output, cache_read: 0, cache_write: 0, calls: m.calls };
  }
  return {
    device_id: deviceId(),
    handle: handle || null,
    mode: "cumulative" as const,
    since: store.firstSynced,
    until: store.lastSynced,
    totals: {
      input: cum.input,
      output: cum.output,
      cache_read: cum.cache_read,
      cache_write: cum.cache_write,
      total: cum.input + cum.output, // leaderboard metric = input + output
    },
    calls: cum.calls,
    sessions: 0, // Cursor's usage API does not expose a session count
    agents: ["cursor"],
    by_agent: {
      cursor: {
        label: "Cursor",
        input: cum.input,
        output: cum.output,
        cache_read: cum.cache_read,
        cache_write: cum.cache_write,
        calls: cum.calls,
      },
    },
    by_model,
    by_day: store.byDay,
    client: { name: "stravibe-cursor", version: CLIENT_VERSION },
  };
}

export interface SyncResult {
  store: Store;
  total: number;
  calls: number;
  rank?: number | null;
  ignored?: boolean;
}

/**
 * Collect the current Cursor usage, fold it into the all-time store, and submit
 * the cumulative total to the leaderboard. The store is persisted BEFORE the
 * network call so local history survives a failed submission; the next sync
 * self-heals because we always send the full (replace-safe) cumulative total.
 */
export async function sync(context: vscode.ExtensionContext, log: Logger): Promise<SyncResult> {
  const token = await getToken(context);
  if (!token) throw new NotLinkedError();

  const snapshot = await collectCursorUsage(log);
  let store = loadStore(context.globalState);

  if (snapshot) {
    store = ingestSnapshot(store, snapshot, new Date().toISOString());
    await saveStore(context.globalState, store);
  } else if (!store.lastSynced) {
    // Nothing collected and nothing banked yet — there is nothing to send.
    throw new NoUsageError();
  }

  const handle = vscode.workspace.getConfiguration("stravibe").get<string>("handle") || null;
  const payload = buildPayload(store, handle);

  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (res.status === 401) {
    throw new NotLinkedError();
  }
  if (!res.ok) {
    throw new Error(`backend ${res.status}: ${text.slice(0, 200)}`);
  }
  let body: { rank?: number | null; ignored?: boolean } = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON ok body */
  }

  const cum = cumulative(store);
  return {
    store,
    total: cum.input + cum.output,
    calls: cum.calls,
    rank: body.rank ?? null,
    ignored: body.ignored,
  };
}
