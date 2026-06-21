import { join } from "node:path";

/**
 * A repository that FIT depends on. On a remote box these live directly under the
 * workspace root (e.g. <workspace>/transactions-fit-performer); locally the
 * checkout lives wherever the user configured it (localhost.repos.<dir>).
 */
export interface Repo {
  /** Human-readable name shown to the user. */
  name: string;
  /** Directory name used when cloning under a workspace root (remote layout). */
  dir: string;
  /** Git URL used to clone the repo if it is missing. */
  url: string;
}

export const FIT_PERFORMER: Repo = {
  name: "transactions-fit-performer",
  dir: "transactions-fit-performer",
  url: "https://github.com/couchbaselabs/transactions-fit-performer/",
};

/**
 * Absolute path where a repo lives under a workspace root. Used for the remote
 * layout (workspace root + repo dir); locally the performer checkout dir is
 * configured directly (see resolveFitPerformerDir).
 */
export function repoPath(repo: Repo, rootDir: string): string {
  return join(rootDir, repo.dir);
}
