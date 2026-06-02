import type * as vscode from "vscode";
import type { CursorUsageSnapshot } from "./cursorUsage";

// Persistent, all-time cumulative store kept in the extension's globalState.
//
// Cursor's usage API reports counts for the CURRENT billing period only — they
// reset at the start of each month (`startOfMonth`). The StraVIBE backend, by
// contrast, expects a cumulative all-time total that only ever GROWS (it uses
// replace-with-a-monotonic-guard semantics). So we keep our own ledger:
//
//   base    = sum of every COMPLETED prior billing period
//   current = the latest snapshot of the active period
//   total   = base + current   (this only grows; safe to re-send)
//
// When Cursor's `startOfMonth` advances, the active period has ended: we bank
// the last-known `current` into `base` and start a fresh `current`. This is
// best-effort — if the extension is offline across a month boundary we may miss
// the final slice of a period, which we accept rather than guess.

const STORE_KEY = "stravibe.store.v1";

export interface ModelAgg {
  input: number;
  output: number;
  calls: number;
}

export interface Bucket {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  calls: number;
  byModel: Record<string, ModelAgg>;
}

export interface Store {
  version: 1;
  periodStart: string | null;
  base: Bucket;
  current: Bucket;
  byDay: Record<string, { input: number; output: number; total: number }>;
  firstSynced: string | null;
  lastSynced: string | null;
  lastCumulativeTotal: number;
}

function emptyBucket(): Bucket {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, calls: 0, byModel: {} };
}

export function emptyStore(): Store {
  return {
    version: 1,
    periodStart: null,
    base: emptyBucket(),
    current: emptyBucket(),
    byDay: {},
    firstSynced: null,
    lastSynced: null,
    lastCumulativeTotal: 0,
  };
}

export function loadStore(state: vscode.Memento): Store {
  const raw = state.get<Store>(STORE_KEY);
  if (!raw || raw.version !== 1) return emptyStore();
  // Defensive: fill any missing fields from a partial/older shape.
  return { ...emptyStore(), ...raw };
}

export async function saveStore(state: vscode.Memento, store: Store): Promise<void> {
  await state.update(STORE_KEY, store);
}

function mergeBuckets(a: Bucket, b: Bucket): Bucket {
  const out: Bucket = {
    input: a.input + b.input,
    output: a.output + b.output,
    cache_read: a.cache_read + b.cache_read,
    cache_write: a.cache_write + b.cache_write,
    calls: a.calls + b.calls,
    byModel: {},
  };
  for (const src of [a.byModel, b.byModel]) {
    for (const [model, m] of Object.entries(src)) {
      const t = (out.byModel[model] ??= { input: 0, output: 0, calls: 0 });
      t.input += m.input;
      t.output += m.output;
      t.calls += m.calls;
    }
  }
  return out;
}

/** Turn a live Cursor snapshot into our bucket shape. */
function bucketFromSnapshot(snap: CursorUsageSnapshot): Bucket {
  const b = emptyBucket();
  for (const m of snap.models) {
    // Cursor reports a single `tokens` total per model, not an input/output
    // split. The leaderboard metric is input+output (cache excluded), so we
    // attribute the whole count to `input`; the score is identical either way,
    // and we never invent a fake split. cache_read/write stay 0 (unavailable).
    b.input += m.tokens;
    b.calls += m.requests;
    const t = (b.byModel[m.model] ??= { input: 0, output: 0, calls: 0 });
    t.input += m.tokens;
    t.calls += m.requests;
  }
  return b;
}

/** The all-time cumulative bucket = base + current. */
export function cumulative(store: Store): Bucket {
  return mergeBuckets(store.base, store.current);
}

/**
 * Fold a fresh Cursor snapshot into the store (mutates a copy and returns it).
 * Handles billing-period rollover and records a best-effort daily delta.
 */
export function ingestSnapshot(store: Store, snap: CursorUsageSnapshot, nowIso: string): Store {
  const next: Store = { ...store, base: { ...store.base, byModel: { ...store.base.byModel } } };

  // Period rollover: the active period ended, bank `current` into `base`.
  if (next.periodStart !== null && next.periodStart !== snap.periodStart) {
    next.base = mergeBuckets(next.base, next.current);
  }
  next.current = bucketFromSnapshot(snap);
  next.periodStart = snap.periodStart;

  // Best-effort by_day: add the positive growth in the cumulative total to
  // today's bucket. Skipped on the very first sync so we don't dump the entire
  // back-catalog into a single day spike on the dashboard graph.
  const cumTotal = (() => {
    const c = cumulative(next);
    return c.input + c.output;
  })();
  if (next.lastCumulativeTotal > 0) {
    const delta = Math.max(0, cumTotal - next.lastCumulativeTotal);
    if (delta > 0) {
      const day = nowIso.slice(0, 10);
      const d = (next.byDay = { ...next.byDay })[day] ?? { input: 0, output: 0, total: 0 };
      next.byDay[day] = { input: d.input + delta, output: d.output, total: d.total + delta };
    }
  }
  next.lastCumulativeTotal = cumTotal;

  if (!next.firstSynced) next.firstSynced = nowIso;
  next.lastSynced = nowIso;
  return next;
}
