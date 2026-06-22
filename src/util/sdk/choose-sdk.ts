/**
 * Step: ask which SDK to test and return it.
 *
 * Run on its own:
 *   bun src/util/sdk/choose-sdk.ts
 *
 * Prints the chosen SDK as JSON.
 */
import { qualifyPromptId, select } from "../non-fit/prompts.js";
import { isMain, runCli } from "../non-fit/cli.js";
import { PREBUILT_PERFORMER_SDKS, sdkByValue, type Sdk, type SdkValue } from "./sdks.js";

export async function chooseSdk(
  message: string = "Which SDK do you want to test?",
  promptIdPrefix?: string,
): Promise<Sdk> {
  // Only the JVM SDKs and C++ publish prebuilt performer images, and fit-cli only
  // runs performers from prebuilt images, so they're the only choices offered.
  const value = await select<SdkValue>({
    promptId: qualifyPromptId("sdk.choose", promptIdPrefix),
    message: `${message} (only JVM and C++ SDKs currently publish prebuilt performer images)`,
    choices: PREBUILT_PERFORMER_SDKS.map((sdk) => ({ name: sdk.name, value: sdk.value })),
  });
  // The selected value always comes from PREBUILT_PERFORMER_SDKS, so this is never undefined.
  return sdkByValue(value)!;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const sdk = await chooseSdk();
    console.log(JSON.stringify(sdk, null, 2));
  });
}
