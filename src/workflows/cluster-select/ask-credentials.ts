/**
 * Step: ask for the username and password FIT will use to test with.
 *
 * Run on its own:
 *   npx tsx src/workflows/cluster-select/ask-credentials.ts
 *
 * Prints the username (and that a password was captured).
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { input, password } from "../../util/non-fit/prompts.js";

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
 * Prompt for the test username and (masked) password, defaulting to
 * {@link DEFAULT_CREDENTIALS}. The username prompt shows the default inline;
 * the password prompt can't carry a default, so a blank entry falls back to it.
 */
export async function askCredentials(): Promise<Credentials> {
  const username = await input({
    message: "Username to test with:",
    default: DEFAULT_CREDENTIALS.username,
  });
  const pw = await password({ message: "Password to test with:", mask: true });
  return { username, password: pw || DEFAULT_CREDENTIALS.password };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { username } = await askCredentials();
    console.log(`username: ${username} (password captured)`);
  });
}
