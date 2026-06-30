/**
 * Step: ask for the username and password FIT will use to test with.
 *
 * Run on its own:
 *   bun src/cluster/cluster-select/ask-credentials.ts
 *
 * Prints the username (and that a password was captured).
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { input, password } from "../../util/non-fit/prompts.js";
import type { ClusterFlavour } from "./classify-connection-string.js";

export interface Credentials {
  username: string;
  password: string;
}

/** The credentials FIT uses out of the box for a self-managed cluster. */
export const DEFAULT_CREDENTIALS: Credentials = {
  username: "Administrator",
  password: "password",
};

/**
 * The database-user credentials FIT creates (via `cbdinocluster users add`) when
 * it allocates a Capella cloud cluster. Capella enforces password complexity, so
 * this must satisfy: ≥1 uppercase, ≥1 lowercase, ≥1 digit, ≥1 special character.
 */
export const CAPELLA_DEFAULT_CREDENTIALS: Credentials = {
  username: "Administrator",
  password: "Password1!",
};

export interface CredentialPromptPolicy {
  usernameDefault?: string;
  passwordDefault?: string;
  guidance?: string[];
}

/** Self-managed clusters have local defaults; Capella needs explicit user input. */
export function credentialPromptPolicy(flavour: ClusterFlavour): CredentialPromptPolicy {
  if (flavour === "self-managed") {
    return {
      usernameDefault: DEFAULT_CREDENTIALS.username,
      passwordDefault: DEFAULT_CREDENTIALS.password,
    };
  }

  return {
    guidance: [
      "→ Capella reminder: create a database user in the Capella UI for FIT to use.",
      "→ Also whitelist this machine's IP address there (or allow all IPs while testing).",
    ],
  };
}

/**
 * Prompt for the test username and (masked) password. Self-managed clusters
 * default to {@link DEFAULT_CREDENTIALS}; Capella clusters require the user to
 * enter explicit credentials.
 */
export async function askCredentials(flavour: ClusterFlavour): Promise<Credentials> {
  const policy = credentialPromptPolicy(flavour);
  for (const line of policy.guidance ?? []) {
    console.log(line);
  }

  const username = await input({
    promptId: "cluster.credentials.username",
    message: "Username to test with:",
    ...(policy.usernameDefault ? { default: policy.usernameDefault } : {}),
    validate: (value) => (value.trim() ? true : "Please enter a username."),
  });
  const pw = await password({
    promptId: "cluster.credentials.password",
    message: "Password to test with:",
    mask: true,
    validate: (value) =>
      value.length > 0 || policy.passwordDefault ? true : "Please enter a password.",
  });
  return { username, password: pw || policy.passwordDefault || "" };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { username } = await askCredentials("self-managed");
    console.log(`username: ${username} (password captured)`);
  });
}
