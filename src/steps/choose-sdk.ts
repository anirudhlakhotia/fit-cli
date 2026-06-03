/**
 * Step: ask which SDK to test and return it.
 *
 * Run on its own:
 *   npx tsx src/steps/choose-sdk.ts
 *
 * Prints the chosen SDK as JSON.
 */
import { select } from "../lib/prompts.js";
import { isMain, runCli } from "../lib/cli.js";
import { SDKS, sdkByValue, type Sdk, type SdkValue } from "../lib/sdks.js";

export async function chooseSdk(message: string = "Which SDK do you want to test?"): Promise<Sdk> {
  const value = await select<SdkValue>({
    message,
    choices: SDKS.map((sdk) => ({ name: sdk.name, value: sdk.value })),
  });
  // The selected value always comes from SDKS, so this is never undefined.
  return sdkByValue(value)!;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const sdk = await chooseSdk();
    console.log(JSON.stringify(sdk, null, 2));
  });
}
