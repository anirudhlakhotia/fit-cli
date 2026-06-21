/**
 * Step: make sure the local transactions-fit-performer checkout is present at a
 * given directory, offering to clone it if it is missing.
 *
 * Run on its own:
 *   npx tsx src/fit/util/ensure-repo.ts /path/to/transactions-fit-performer
 *
 * Exits 0 if the repo is ready, 1 if the user chose to bail or the clone failed.
 */
import { existsSync } from "node:fs";
import { select } from "../../util/non-fit/prompts.js";
import { fitCliError } from "../../util/non-fit/fit-cli-log.js";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { run } from "../../util/non-fit/proc.js";
import { FIT_PERFORMER, type Repo } from "./repos.js";

export function cloneRepoChoiceLabel(repo: Repo, targetDir: string): string {
  return `Clone it from ${repo.url} to ${targetDir}`;
}

/**
 * Ensure `repo` is checked out at `targetDir`, cloning it there if missing.
 *
 * @returns true if the repo is ready to use, false if the user chose to exit or
 * the clone failed.
 */
export async function ensureRepo(repo: Repo, targetDir: string): Promise<boolean> {
  if (existsSync(targetDir)) {
    console.log(`✓ Found ${repo.name} at ${targetDir}`);
    return true;
  }

  fitCliError(`Could not find ${repo.name} at ${targetDir}`);

  const action = await select({
    promptId: `repo.${repo.name}.missing.action`,
    message: `What would you like to do about the missing ${repo.name}?`,
    choices: [
      { name: cloneRepoChoiceLabel(repo, targetDir), value: "clone" },
      { name: "Exit so I can sort it out myself", value: "exit" },
    ],
  });

  if (action === "exit") {
    return false;
  }

  console.log(`\nCloning ${repo.name} into ${targetDir}...\n`);
  try {
    await run("git", ["clone", repo.url, targetDir]);
    console.log(`\n✓ Cloned ${repo.name} to ${targetDir}`);
    return true;
  } catch (err) {
    fitCliError(`\nFailed to clone ${repo.name}: ${(err as Error).message}`);
    return false;
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const targetDir = process.argv[2];
    if (!targetDir || targetDir.startsWith("-")) {
      fitCliError("Usage: tsx src/fit/util/ensure-repo.ts <path-to-transactions-fit-performer-checkout>");
      process.exit(2);
    }
    const ok = await ensureRepo(FIT_PERFORMER, targetDir);
    process.exit(ok ? 0 : 1);
  });
}
