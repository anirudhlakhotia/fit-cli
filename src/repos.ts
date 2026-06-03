import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A sibling repository that FIT depends on. By convention these live next to
 * fit-cli, i.e. as siblings of this project's directory.
 */
export interface Repo {
  /** Human-readable name shown to the user. */
  name: string;
  /** Directory name, expected as a sibling of fit-cli (e.g. ../transactions-fit-performer). */
  dir: string;
  /** Git URL used to clone the repo if it is missing. */
  url: string;
}

export const FIT_PERFORMER: Repo = {
  name: "transactions-fit-performer",
  dir: "transactions-fit-performer",
  url: "https://github.com/couchbaselabs/transactions-fit-performer/",
};

export const JVM_CLIENTS: Repo = {
  name: "couchbase-jvm-clients",
  dir: "couchbase-jvm-clients",
  url: "https://github.com/couchbase/couchbase-jvm-clients",
};

/** Absolute path to the fit-cli project root (one level up from src/). */
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The directory that holds fit-cli and its sibling repos. */
const siblingRoot = resolve(projectRoot, "..");

/** Absolute path where a sibling repo is (or would be) located. */
export function repoPath(repo: Repo): string {
  return join(siblingRoot, repo.dir);
}

/** True if the sibling repo already exists on disk. */
export function repoExists(repo: Repo): boolean {
  return existsSync(repoPath(repo));
}

/** Clone a repo into the sibling root, streaming git output to the console. */
export function cloneRepo(repo: Repo): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["clone", repo.url, repo.dir], {
      cwd: siblingRoot,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`git clone exited with code ${code}`));
      }
    });
  });
}
