/**
 * Step: make sure a sibling repo (transactions-fit-performer, jenkins-sdk)
 * is present, offering to clone it if it is missing.
 *
 * Run on its own (optionally with --root <dir> to point at another workspace):
 *   npx tsx src/fit/util/ensure-repo.ts transactions-fit-performer
 *   npx tsx src/fit/util/ensure-repo.ts jenkins-sdk --root /some/workspace
 *
 * Exits 0 if the repo is ready, 1 if the user chose to bail or the clone failed.
 */
import { select } from "../../util/non-fit/prompts.js";
import { fitCliError } from "../../util/non-fit/fit-cli-log.js";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { REPOS, cloneRepo, repoExists, repoPath, type Repo, type RepoKey } from "./repos.js";
import { rootDirFromArgv } from "./root.js";

function resolveRepo(arg: string | undefined): Repo | undefined {
  if (!arg) {
    return undefined;
  }

  return REPOS[arg as RepoKey] ?? Object.values(REPOS).find((repo) => repo.name === arg);
}

export function cloneRepoChoiceLabel(repo: Repo, rootDir: string): string {
  return `Clone it from ${repo.url} to ${repoPath(repo, rootDir)} (under ROOT_DIR: ${rootDir})`;
}

/**
 * @returns true if the repo is ready to use, false if the user chose to exit or
 * the clone failed.
 */
export async function ensureRepo(repo: Repo, rootDir: string): Promise<boolean> {
  if (repoExists(repo, rootDir)) {
    console.log(`✓ Found ${repo.name} at ${repoPath(repo, rootDir)}`);
    return true;
  }

  fitCliError(`Could not find ${repo.name} at ${repoPath(repo, rootDir)}`);

  const action = await select({
    promptId: `repo.${repo.name}.missing.action`,
    message: `What would you like to do about the missing ${repo.name}?`,
    choices: [
      { name: cloneRepoChoiceLabel(repo, rootDir), value: "clone" },
      { name: "Exit so I can sort it out myself", value: "exit" },
    ],
  });

  if (action === "exit") {
    return false;
  }

  console.log(`\nCloning ${repo.name} into ${repoPath(repo, rootDir)}...\n`);
  try {
    await cloneRepo(repo, rootDir);
    console.log(`\n✓ Cloned ${repo.name} to ${repoPath(repo, rootDir)}`);
    return true;
  } catch (err) {
    fitCliError(`\nFailed to clone ${repo.name}: ${(err as Error).message}`);
    return false;
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir, positionals } = rootDirFromArgv(process.argv.slice(2));
    const repo = resolveRepo(positionals[0]);
    if (!repo) {
      fitCliError(
        `Usage: tsx src/util/fit/ensure-repo.ts <${Object.values(REPOS)
          .map((repo) => repo.name)
          .join(" | ")}> [--root <dir>]`,
      );
      process.exit(2);
    }
    const ok = await ensureRepo(repo, rootDir);
    process.exit(ok ? 0 : 1);
  });
}
