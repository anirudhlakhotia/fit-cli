/**
 * Step: make sure a sibling repo (transactions-fit-performer, couchbase-jvm-clients)
 * is present, offering to clone it if it is missing.
 *
 * Run on its own:
 *   npx tsx src/steps/ensure-repo.ts fit-performer
 *   npx tsx src/steps/ensure-repo.ts jvm-clients
 *
 * Exits 0 if the repo is ready, 1 if the user chose to bail or the clone failed.
 */
import { select } from "@inquirer/prompts";
import { isMain, runCli } from "../lib/cli.js";
import { REPOS, cloneRepo, repoExists, repoPath, type Repo, type RepoKey } from "../lib/repos.js";

/**
 * @returns true if the repo is ready to use, false if the user chose to exit or
 * the clone failed.
 */
export async function ensureRepo(repo: Repo): Promise<boolean> {
  if (repoExists(repo)) {
    console.log(`✓ Found ${repo.name} at ${repoPath(repo)}`);
    return true;
  }

  console.log(`✗ Could not find ${repo.name} at ${repoPath(repo)}`);

  const action = await select({
    message: `What would you like to do about the missing ${repo.name}?`,
    choices: [
      { name: `Clone it from ${repo.url}`, value: "clone" },
      { name: "Exit so I can sort it out myself", value: "exit" },
    ],
  });

  if (action === "exit") {
    return false;
  }

  console.log(`\nCloning ${repo.name}...\n`);
  try {
    await cloneRepo(repo);
    console.log(`\n✓ Cloned ${repo.name} to ${repoPath(repo)}`);
    return true;
  } catch (err) {
    console.error(`\n✗ Failed to clone ${repo.name}: ${(err as Error).message}`);
    return false;
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const key = process.argv[2] as RepoKey;
    const repo = REPOS[key];
    if (!repo) {
      console.error(`Usage: tsx src/steps/ensure-repo.ts <${Object.keys(REPOS).join(" | ")}>`);
      process.exit(2);
    }
    const ok = await ensureRepo(repo);
    process.exit(ok ? 0 : 1);
  });
}
