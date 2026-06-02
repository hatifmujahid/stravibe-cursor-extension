import * as os from "node:os";
import { createHash } from "node:crypto";

/**
 * Stable, anonymous machine id for THIS extension (no PII).
 *
 * Deliberately DISTINCT from the npm CLI's `d_<hash>` id (see
 * stravibe-npm-package/src/identity.js). The backend keys one usage row per
 * (account, device_id) and REPLACES it on each import. If the extension reused
 * the CLI's device_id, a Cursor sync would clobber the machine's Claude Code /
 * Codex row. With a separate `cur_` id the Cursor row is its own per-device row,
 * so Cursor tokens ADD to the user's leaderboard total (the score is the SUM of
 * a user's per-device rows) instead of overwriting another agent's usage.
 *
 * Matches the backend's device_id regex: ^[A-Za-z0-9_-]{3,64}$.
 */
export function deviceId(): string {
  const seed = `${os.hostname()}::${os.homedir()}::${os.userInfo().username}::cursor-ext`;
  return "cur_" + createHash("sha256").update(seed).digest("hex").slice(0, 24);
}
