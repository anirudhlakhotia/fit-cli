/**
 * Push a generated definition file to a GitHub Gist.
 */
import { basename } from "node:path";
import { resolveGithubToken } from "../../util/config.js";

export type GistVisibility = "public" | "private";

/**
 * Extract `--push-gist [public|private]` from a positional argv slice.
 * Returns the visibility if the flag is present, otherwise `undefined`.
 * `--push-gist` with no value (or a non-visibility next token) defaults to
 * `"public"`.  Throws on an explicit bad value like `--push-gist=bad`.
 */
export function extractPushGistVisibility(argv: readonly string[]): GistVisibility | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--push-gist") {
      const next = argv[i + 1];
      return next === "public" || next === "private" ? next : "public";
    }
    if (arg.startsWith("--push-gist=")) {
      const val = arg.slice("--push-gist=".length);
      if (val !== "public" && val !== "private") {
        throw new Error(`--push-gist value must be "public" or "private", got: ${val}`);
      }
      return val;
    }
  }
  return undefined;
}

export interface PushGistResult {
  url: string;
  id: string;
}

/**
 * Create a GitHub Gist from a local file's content.  Uses the GitHub token
 * from fit-cli config / environment (GITHUB_TOKEN / GH_TOKEN).  Throws if no
 * token is available or if the API call fails.
 */
export async function pushGist(
  filePath: string,
  content: string,
  visibility: GistVisibility = "public",
): Promise<PushGistResult> {
  const token = resolveGithubToken();
  if (!token) {
    throw new Error(
      "No GitHub token found.  Set github.token in your fit-cli config, or export GITHUB_TOKEN / GH_TOKEN.",
    );
  }

  const filename = basename(filePath);
  const body = JSON.stringify({
    description: `FIT definition — ${filename}`,
    public: visibility === "public",
    files: { [filename]: { content } },
  });

  const response = await fetch("https://api.github.com/gists", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub Gist API returned ${response.status}: ${text}`);
  }

  const data = (await response.json()) as { html_url: string; id: string };
  return { url: data.html_url, id: data.id };
}
