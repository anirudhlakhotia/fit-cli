/**
 * Step: ask which SDK version to build. A blank response means "main".
 *
 * Run on its own:
 *   npx tsx src/workflows/build-fit-performer/steps/ask-version.ts
 *
 * Prints the chosen version, or an empty string for main.
 */
import { input } from "@inquirer/prompts";
import { isMain, runCli } from "../../../lib/cli.js";

/** Ask which SDK version to build; blank means build main. */
export async function askVersion(): Promise<string | undefined> {
  const version = await input({
    message: "Which version do you want to build? Leave blank for main.",
    default: "",
  });
  const trimmed = version.trim();
  return trimmed || undefined;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    console.log((await askVersion()) ?? "");
  });
}
