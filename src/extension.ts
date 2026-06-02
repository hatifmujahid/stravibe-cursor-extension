import * as vscode from "vscode";
import { LEADERBOARD_URL } from "./config";
import { getUser, isLinked, login, logout, type LinkedUser } from "./auth";
import { NoUsageError, NotLinkedError, sync } from "./submit";

let statusBar: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let timer: ReturnType<typeof setInterval> | undefined;
let lastTotal = 0;

function log(msg: string): void {
  output.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

/** Compact number formatting for the status bar (1.2M, 994k, 320). */
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

async function updateStatusBar(context: vscode.ExtensionContext): Promise<void> {
  const linked = await isLinked(context);
  if (!linked) {
    statusBar.text = "$(graph) StraVIBE: sign in";
    statusBar.tooltip = "Click to link your StraVIBE account and start reporting Cursor usage.";
  } else {
    const user: LinkedUser | undefined = getUser(context);
    const who = user?.name || user?.login || user?.email || "linked";
    statusBar.text = `$(graph) StraVIBE: ${fmt(lastTotal)}`;
    statusBar.tooltip = `StraVIBE — ${who}\nCumulative Cursor tokens reported: ${lastTotal.toLocaleString()}\nClick for options.`;
  }
  statusBar.show();
}

/** Run a sync and reflect the result in the UI. `interactive` shows messages. */
async function runSync(context: vscode.ExtensionContext, interactive: boolean): Promise<void> {
  try {
    const result = await sync(context, log);
    lastTotal = result.total;
    log(`synced: total=${result.total} calls=${result.calls} rank=${result.rank ?? "?"}${result.ignored ? " (ignored: non-monotonic)" : ""}`);
    if (interactive) {
      const rank = result.rank ? ` — rank #${result.rank}` : "";
      vscode.window.showInformationMessage(`StraVIBE synced: ${result.total.toLocaleString()} tokens${rank}.`);
    }
  } catch (err) {
    const e = err as Error & { code?: string };
    log(`sync failed: ${e.message}`);
    if (e instanceof NotLinkedError) {
      if (interactive) {
        const pick = await vscode.window.showWarningMessage("StraVIBE: you're not signed in.", "Sign in");
        if (pick === "Sign in") await vscode.commands.executeCommand("stravibe.login");
      }
    } else if (e instanceof NoUsageError) {
      if (interactive) {
        vscode.window.showWarningMessage("StraVIBE: no Cursor usage found yet. Make sure you're signed in to Cursor. See StraVIBE diagnostics for details.");
      }
    } else if (interactive) {
      vscode.window.showErrorMessage(`StraVIBE sync failed: ${e.message}`);
    }
  } finally {
    await updateStatusBar(context);
  }
}

function restartTimer(context: vscode.ExtensionContext): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  const cfg = vscode.workspace.getConfiguration("stravibe");
  if (!cfg.get<boolean>("autoSync", true)) return;
  const minutes = Math.max(5, cfg.get<number>("syncIntervalMinutes", 30));
  timer = setInterval(() => void runSync(context, false), minutes * 60 * 1000);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("StraVIBE");
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "stravibe.showMenu";
  context.subscriptions.push(output, statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("stravibe.login", async () => {
      try {
        const user = await login(context);
        if (user) {
          vscode.window.showInformationMessage("StraVIBE: account linked. Syncing your Cursor usage…");
          await runSync(context, false);
          restartTimer(context);
        }
      } catch (err) {
        vscode.window.showErrorMessage(`StraVIBE sign-in failed: ${(err as Error).message}`);
      } finally {
        await updateStatusBar(context);
      }
    }),

    vscode.commands.registerCommand("stravibe.logout", async () => {
      await logout(context);
      if (timer) clearInterval(timer);
      vscode.window.showInformationMessage("StraVIBE: signed out.");
      await updateStatusBar(context);
    }),

    vscode.commands.registerCommand("stravibe.syncNow", () => runSync(context, true)),

    vscode.commands.registerCommand("stravibe.openLeaderboard", () =>
      vscode.env.openExternal(vscode.Uri.parse(LEADERBOARD_URL)),
    ),

    vscode.commands.registerCommand("stravibe.showDiagnostics", () => output.show()),

    // Status-bar click menu.
    vscode.commands.registerCommand("stravibe.showMenu", async () => {
      const linked = await isLinked(context);
      const items: (vscode.QuickPickItem & { run: () => void })[] = linked
        ? [
            { label: "$(sync) Sync now", run: () => void runSync(context, true) },
            { label: "$(globe) Open leaderboard", run: () => void vscode.commands.executeCommand("stravibe.openLeaderboard") },
            { label: "$(output) Show diagnostics", run: () => output.show() },
            { label: "$(sign-out) Sign out", run: () => void vscode.commands.executeCommand("stravibe.logout") },
          ]
        : [{ label: "$(sign-in) Sign in to StraVIBE", run: () => void vscode.commands.executeCommand("stravibe.login") }];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: "StraVIBE" });
      pick?.run();
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("stravibe.autoSync") || e.affectsConfiguration("stravibe.syncIntervalMinutes")) {
        restartTimer(context);
      }
    }),
  );

  await updateStatusBar(context);

  // Sync on startup if already linked, then start the background timer.
  if (await isLinked(context)) {
    void runSync(context, false);
    restartTimer(context);
  }
}

export function deactivate(): void {
  if (timer) clearInterval(timer);
}
