/**
 * Step: ask which SDK version to build. A blank response means "main".
 *
 * Run on its own:
 *   npx tsx src/workflows/performers/build-performer/ask-version.ts
 *
 * Prints the chosen version, or an empty string for main.
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { input, qualifyPromptId } from "../../../util/non-fit/prompts.js";

/** Ask which SDK version to build; blank means build main. */
export async function askVersion(promptIdPrefix?: string): Promise<string | undefined> {
  const version = await input({
    promptId: qualifyPromptId("performer.version", promptIdPrefix),
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
