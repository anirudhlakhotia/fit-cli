/**
 * Step: ask which prebuilt performer image tag to use for an SDK.
 *
 * fit-cli only runs prebuilt performer images from GHCR, so all the guided
 * performer flows pick an SDK and then a tag; the full image reference is
 * `<sdk>-fit-performer:<tag>` (see performer-image.ts).
 *
 * Run on its own:
 *   npx tsx src/fit/performers/util/ask-performer-image.ts
 *
 * Prints the chosen tag.
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { input, qualifyPromptId } from "../../../util/non-fit/prompts.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import { type Sdk } from "../../../util/sdk/sdks.js";
import { sdkDefaultPerformerTag, validatePerformerVersion } from "./performer-image.js";

/** Ask which prebuilt performer image tag to use; blank means the SDK default (main). */
export async function askPerformerTag(sdk: Sdk, promptIdPrefix?: string): Promise<string> {
  const defaultTag = sdkDefaultPerformerTag(sdk);
  const tag = await input({
    promptId: qualifyPromptId("performer.tag", promptIdPrefix),
    message: `Which ${sdk.name} performer image tag do you want? Leave blank for ${defaultTag}.`,
    default: defaultTag,
    validate: validatePerformerVersion,
  });
  return tag.trim() || defaultTag;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const sdk = await chooseSdk();
    console.log(await askPerformerTag(sdk));
  });
}
