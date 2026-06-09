/**
 * Step: make sure the cbdinocluster binary is available and working. It's looked
 * for on the PATH first; if it isn't there the user is asked where it lives (and
 * pointed at where to get it). Either way it's sanity-checked by running
 * `cbdinocluster ps`, so we fail early with a clear message if the binary is
 * broken or misconfigured rather than later inside `allocate`.
 *
 * Run on its own:
 *   npx tsx src/cluster/cluster-create/ensure-cbdinocluster.ts
 *
 * Prints the resolved cbdinocluster command, or exits 1 if it isn't usable.
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { fitCliError } from "../../util/non-fit/fit-cli-log.js";
import { input } from "../../util/non-fit/prompts.js";
import { run } from "../../util/non-fit/proc.js";
import { findOnPath } from "../../util/non-fit/which.js";

/** Where to get cbdinocluster, shown when it can't be found on the PATH. */
export const CBDINOCLUSTER_URL = "https://github.com/couchbaselabs/cbdinocluster";

/** The bare command name we look for on the PATH. */
const CBDINOCLUSTER = "cbdinocluster";

/**
 * Resolve the cbdinocluster command to use: its location on the PATH if it's
 * there, otherwise ask the user for the full path to the binary.
 */
async function resolveCbdinocluster(): Promise<string> {
  const onPath = findOnPath(CBDINOCLUSTER);
  if (onPath) {
    console.log(`✓ Found cbdinocluster on your PATH at ${onPath}`);
    return onPath;
  }

  fitCliError(`cbdinocluster is not on your PATH. You can get it from ${CBDINOCLUSTER_URL}.`);
  return input({
    promptId: "cluster.create.cbdinocluster-path",
    message: "Path to your cbdinocluster binary:",
  });
}

/**
 * Ensure cbdinocluster is usable, returning the command to invoke it with, or
 * null if the sanity check failed. The sanity check is `cbdinocluster ps`, whose
 * output is streamed so the user can see their current clusters.
 */
export async function ensureCbdinocluster(): Promise<string | null> {
  const cbdinocluster = await resolveCbdinocluster();

  console.log("\nSanity-checking cbdinocluster with `cbdinocluster ps`...\n");
  try {
    await run(cbdinocluster, ["ps"]);
    console.log("\n✓ cbdinocluster works");
    return cbdinocluster;
  } catch (err) {
    fitCliError(`\ncbdinocluster does not seem to work: ${(err as Error).message}`);
    return null;
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const cbdinocluster = await ensureCbdinocluster();
    process.exit(cbdinocluster ? 0 : 1);
  });
}
