/**
 * Step: ask what the definition should do if the performer port is already in
 * use when its setup-performer step runs. The answer is written into the
 * definition's `performer.onPortInUse` field; the policy itself lives in
 * performer-port.ts.
 *
 * Run on its own:
 *   npx tsx src/workflows/performers/ask-port-in-use-policy.ts
 *
 * Prints the chosen policy.
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { select } from "../../util/non-fit/prompts.js";
import { DEFAULT_PORT_IN_USE_POLICY, type PortInUsePolicy } from "./performer-port.js";

/** Ask which port-in-use policy to record in the definition. */
export async function askPortInUsePolicy(): Promise<PortInUsePolicy> {
  return select<PortInUsePolicy>({
    promptId: "performer.on-port-in-use",
    message:
      "If the performer port is already in use when this definition runs, what should happen?",
    choices: [
      {
        name: "reuse — assume a performer is already running and test against it (default - convenient for local development, lets you run the performer yourself)",
        value: "reuse",
      },
      {
        name: "restart — stop what's there and bring up a fresh performer (good for clean testing)",
        value: "restart",
      },
      {
        name: "fail — stop the run rather than touch whatever is there",
        value: "fail",
      },
    ],
    default: DEFAULT_PORT_IN_USE_POLICY,
  });
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    console.log(await askPortInUsePolicy());
  });
}
