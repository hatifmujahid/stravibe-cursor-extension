# StraVIBE

Report your **AI coding usage** to the [StraVIBE](https://stravibe.vercel.app)
leaderboard — *Strava for vibe coders*. A status-bar widget that links your
account, reads your editor's token usage, and submits the cumulative total to
the leaderboard backend.

Runs in any VS Code-based editor. Usage is read per editor via a dedicated
collector — **Cursor** is supported today, with VS Code and Antigravity
planned. Each editor reports as its own device, so usage **adds** rather than
overwrites.

This is the editor companion to the [`stravibe`](https://www.npmjs.com/package/stravibe)
CLI (which covers Claude Code and Codex). Run both and your editor usage **adds
to** your Claude Code / Codex usage on the same machine — they report as
separate devices and the backend sums them.

## Install

The in-app **Extensions** panel of VS Code / Cursor installs from
[Open VSX](https://open-vsx.org). Once published there, search "StraVIBE" and
click Install. Or sideload the `.vsix`: **Extensions → ⋯ → Install from VSIX…**.

## Use

1. Click the **`$(graph) StraVIBE`** item in the status bar → **Sign in**. A
   browser opens to link your GitHub or email account (same flow as the CLI).
2. After linking it syncs immediately, then re-syncs every 30 minutes
   (configurable). Click the status bar any time to **Sync now**, open the
   leaderboard, or sign out.

### Settings

| Setting | Default | Description |
|---|---|---|
| `stravibe.autoSync` | `true` | Sync usage in the background. |
| `stravibe.syncIntervalMinutes` | `30` | Background sync cadence (min 5). |
| `stravibe.handle` | `""` | Optional public display name on the leaderboard. |

## How it reads usage — and the honest caveats

Usage is collected per editor. The sections below describe the **Cursor**
collector (`src/cursorUsage.ts`), the one supported today; other editors will
get their own collectors following the same fail-safe pattern.

Cursor exposes **no public extension API** for token usage. To get real numbers
this extension:

1. Reads the Cursor **session token** from Cursor's local SQLite database
   (`globalStorage/state.vscdb`).
2. Calls Cursor's **own internal usage endpoint** (`cursor.com/api/usage`) with
   that token and maps the per-model counts into StraVIBE's cumulative payload.

Consequences you should know:

- **Undocumented / fragile.** Cursor can change the storage key or the endpoint
  at any time. The collector is shipped `verified: false` and **fails safe** —
  on any mismatch it contributes *nothing* rather than guessing
  (`src/cursorUsage.ts`). Verify it on a real machine and flip `VERIFIED` to
  `true`.
- **Token shape.** Cursor reports a single token total per model, not an
  input/output split. Since the leaderboard metric is `input + output`, the full
  count is attributed to `input` (cache fields stay `0`) — the score is
  identical either way.
- **Monthly reset → all-time.** Cursor's counts reset each billing month. The
  extension keeps its own cumulative ledger (`src/store.ts`) so the submitted
  total only ever grows, matching the backend's replace-with-monotonic-guard
  contract.

### Privacy

Only **token counts, request counts, model names, and the billing-period start**
leave your machine. Prompts, code, file paths, and chat content are never read.

## Build & package

```sh
npm install
npm run compile        # tsc -> out/
npm run package        # vsce package -> stravibe-extension-<version>.vsix
npm run publish:ovsx   # ovsx publish  (needs OVSX_PAT)
```

Publishing to Open VSX requires an account, a namespace matching the
`publisher` field in `package.json`, and a personal access token
(`ovsx create-namespace stravibe -p $OVSX_PAT` once, then `ovsx publish`).

## License

UNLICENSED — © Muhammad Hatif Mujahid. Part of the StraVIBE project.
