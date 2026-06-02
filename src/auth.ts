import * as vscode from "vscode";
import { authUrl } from "./config";
import { deviceId } from "./deviceId";

// Device-authorization login against the StraVIBE backend — the SAME flow the
// npm CLI uses (stravibe-npm-package/src/auth.js):
//   POST /auth/cli/start { device_id, provider } -> { user_code, verification_url, device_code, interval }
//   POST /auth/cli/poll  { device_code }         -> 202 pending | 200 { token, user }
//
// The bearer token is stored in VS Code SecretStorage (the OS keychain), never
// in plaintext settings or globalState.

const TOKEN_SECRET = "stravibe.bearerToken";
const USER_KEY = "stravibe.user";

export interface LinkedUser {
  name?: string;
  login?: string;
  email?: string;
  [k: string]: unknown;
}

export async function getToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get(TOKEN_SECRET);
}

export function getUser(context: vscode.ExtensionContext): LinkedUser | undefined {
  return context.globalState.get<LinkedUser>(USER_KEY);
}

export async function isLinked(context: vscode.ExtensionContext): Promise<boolean> {
  return !!(await getToken(context));
}

export async function logout(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(TOKEN_SECRET);
  await context.globalState.update(USER_KEY, undefined);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run the full device-auth flow with a cancellable progress notification.
 * Returns the linked user on success, or undefined if cancelled/timed out.
 */
export async function login(context: vscode.ExtensionContext): Promise<LinkedUser | undefined> {
  const startRes = await fetch(authUrl("start"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: deviceId(), provider: null }),
  });
  if (!startRes.ok) {
    throw new Error(`auth start failed: ${startRes.status}`);
  }
  const { verification_url, user_code, device_code, interval = 5 } = (await startRes.json()) as {
    verification_url: string;
    user_code?: string;
    device_code: string;
    interval?: number;
  };

  await vscode.env.openExternal(vscode.Uri.parse(verification_url));

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      cancellable: true,
      title: user_code
        ? `StraVIBE: finish sign-in in your browser (code ${user_code})`
        : "StraVIBE: finish sign-in in your browser…",
    },
    async (_progress, cancelToken) => {
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        if (cancelToken.isCancellationRequested) return undefined;
        await sleep(interval * 1000);
        const pollRes = await fetch(authUrl("poll"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ device_code }),
        });
        if (pollRes.status === 202) continue; // still pending
        if (!pollRes.ok) throw new Error(`auth poll failed: ${pollRes.status}`);
        const { token, user } = (await pollRes.json()) as { token: string; user: LinkedUser };
        await context.secrets.store(TOKEN_SECRET, token);
        await context.globalState.update(USER_KEY, user ?? {});
        return user ?? {};
      }
      throw new Error("login timed out — please run StraVIBE: Sign in again");
    },
  );
}
