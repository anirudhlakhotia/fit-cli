import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "../non-fit/proc.js";

/**
 * A repository that FIT depends on. These live directly under ROOT_DIR (see
 * util/fit/root.ts), e.g. <ROOT_DIR>/transactions-fit-performer.
 */
export interface Repo {
  /** Human-readable name shown to the user. */
  name: string;
  /** Directory name, expected directly under ROOT_DIR (e.g. transactions-fit-performer). */
  dir: string;
  /** Git URL used to clone the repo if it is missing. */
  url: string;
}

export const FIT_PERFORMER: Repo = {
  name: "transactions-fit-performer",
  dir: "transactions-fit-performer",
  url: "https://github.com/couchbaselabs/transactions-fit-performer/",
};

export const JENKINS_SDK: Repo = {
  name: "jenkins-sdk",
  dir: "jenkins-sdk",
  url: "https://github.com/couchbaselabs/jenkins-sdk",
};

/** Repos addressable by a short key, for the step CLIs. */
export const REPOS = {
  "fit-performer": FIT_PERFORMER,
  "jenkins-sdk": JENKINS_SDK,
} as const;

export type RepoKey = keyof typeof REPOS;

/** Absolute path where a repo is (or would be) located, directly under ROOT_DIR. */
export function repoPath(repo: Repo, rootDir: string): string {
  return join(rootDir, repo.dir);
}

/** True if the repo already exists on disk under ROOT_DIR. */
export function repoExists(repo: Repo, rootDir: string): boolean {
  return existsSync(repoPath(repo, rootDir));
}

/** Clone a repo into ROOT_DIR, streaming git output to the console. */
export function cloneRepo(repo: Repo, rootDir: string): Promise<void> {
  return run("git", ["clone", repo.url, repo.dir], rootDir);
}
