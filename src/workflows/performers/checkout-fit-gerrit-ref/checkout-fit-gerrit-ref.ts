/**
 * Step: fetch and checkout transactions-fit-performer at a specific Gerrit ref.
 *
 * Run on its own (add --root <dir> to point at another workspace):
 *   npx tsx src/workflows/performers/checkout-fit-gerrit-ref/checkout-fit-gerrit-ref.ts refs/changes/29/246329/1
 */
import { spawnSync } from "node:child_process";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliError } from "../../../util/non-fit/fit-cli-log.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { createLocalFitExecutionContext, type FitExecutionContext } from "../../fit-shared/util/remote-fit-run.js";

export const FIT_GERRIT_HOST = "review.couchbase.org";
export const FIT_GERRIT_PORT = 29418;
export const FIT_PERFORMER_GERRIT_REPO = "transactions-fit-performer";

export function resolveFitGerritUser(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.FIT_GERRIT_USER ?? env.GERRIT_USER;
  const trimmed = configured?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveGerritUserFromGitConfig(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const result = spawnSync("git", ["config", "--global", "github.user"], { env, encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) {
    return undefined;
  }
  return result.stdout.trim() || undefined;
}

export function requireFitGerritUser(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = resolveFitGerritUser(env);
  if (fromEnv) {
    return fromEnv;
  }
  const fromGitConfig = resolveGerritUserFromGitConfig(env);
  if (fromGitConfig) {
    return fromGitConfig;
  }
  throw new Error(
    "Cannot determine Gerrit username. Set FIT_GERRIT_USER, GERRIT_USER, or run: git config --global github.user <your-username>",
  );
}

export function fitPerformerGerritUrl(gerritUser: string): string {
  return `ssh://${gerritUser}@${FIT_GERRIT_HOST}:${FIT_GERRIT_PORT}/${FIT_PERFORMER_GERRIT_REPO}`;
}

export function fitPerformerGerritFetchArgs(gerritRef: string, gerritUser: string): string[] {
  return ["fetch", fitPerformerGerritUrl(gerritUser), gerritRef];
}

export function checkoutFetchHeadArgs(): string[] {
  return ["checkout", "FETCH_HEAD"];
}

export function gitStatusIsClean(status: string): boolean {
  return status.trim() === "";
}

export async function checkoutFitGerritRef(
  execution: FitExecutionContext,
  gerritRef: string,
): Promise<boolean> {
  const trimmedRef = gerritRef.trim();
  if (!trimmedRef) {
    fitCliError("A FIT Gerrit ref was requested, but it was blank.");
    return false;
  }

  let gerritUser: string;
  try {
    gerritUser = requireFitGerritUser();
  } catch (err) {
    fitCliError((err as Error).message);
    return false;
  }

  let status: string;
  try {
    status = await execution.capture("git", ["status", "--porcelain"], execution.fitPerformerDir);
  } catch (err) {
    fitCliError(
      `Could not inspect ${execution.fitPerformerDir} before checking out Gerrit ref ${trimmedRef}: ${(err as Error).message}`,
    );
    return false;
  }

  if (!gitStatusIsClean(status)) {
    fitCliError(
      `Refusing to checkout Gerrit ref ${trimmedRef} because ${execution.fitPerformerDir} is not clean:\n${status.trim()}`,
    );
    return false;
  }

  console.log(
    `\nAdding ${FIT_GERRIT_HOST} to known_hosts with:\n  ssh-keyscan -p ${FIT_GERRIT_PORT} ${FIT_GERRIT_HOST} >> ~/.ssh/known_hosts\n`,
  );
  try {
    await execution.run("sh", [
      "-c",
      `mkdir -p ~/.ssh && chmod 700 ~/.ssh && ssh-keyscan -p ${FIT_GERRIT_PORT} ${FIT_GERRIT_HOST} >> ~/.ssh/known_hosts`,
    ]);
  } catch (err) {
    console.warn(`Warning: could not pre-seed known_hosts for ${FIT_GERRIT_HOST}: ${(err as Error).message}`);
  }

  console.log(
    `\nFetching FIT Gerrit ref with:\n  git ${fitPerformerGerritFetchArgs(trimmedRef, gerritUser).join(" ")}\n`,
  );

  try {
    await execution.run("git", fitPerformerGerritFetchArgs(trimmedRef, gerritUser), execution.fitPerformerDir);
    console.log(`\nChecking out fetched FIT Gerrit ref with:\n  git ${checkoutFetchHeadArgs().join(" ")}\n`);
    await execution.run("git", checkoutFetchHeadArgs(), execution.fitPerformerDir);
  } catch (err) {
    const message = (err as Error).message;
    const hints: string[] = [];
    if (message.includes("Host key verification failed")) {
      hints.push(`The machine running git does not trust ${FIT_GERRIT_HOST} yet.`);
    }
    if (execution.kind === "remote") {
      hints.push("A clean remote box also needs Gerrit SSH credentials (for example agent forwarding or a key already uploaded in Gerrit).");
    }
    fitCliError(
      `Failed to checkout FIT Gerrit ref ${trimmedRef}: ${message}${hints.length > 0 ? ` ${hints.join(" ")}` : ""}`,
    );
    return false;
  }

  console.log(`\n✓ Checked out FIT Gerrit ref ${trimmedRef}`);
  return true;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir, positionals } = rootDirFromArgv(process.argv.slice(2));
    const gerritRef = positionals[0];
    if (!gerritRef || positionals.length > 1) {
      console.error(
        "Usage: tsx src/workflows/performers/checkout-fit-gerrit-ref/checkout-fit-gerrit-ref.ts <refs/changes/...> [--root <dir>]",
      );
      process.exit(2);
    }
    process.exit((await checkoutFitGerritRef(createLocalFitExecutionContext(rootDir), gerritRef)) ? 0 : 1);
  });
}
