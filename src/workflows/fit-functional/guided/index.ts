/**
 * The "Run functional tests" guided flow. This orchestrates the steps needed to
 * run FIT functional tests for one SDK. Generic steps it reuses live under
 * src/steps/ and src/lib/; the FIT-functional steps live under ../steps/
 * alongside this guided flow.
 *
 * Run this flow on its own (skipping the top-level menu; add --root <dir> to
 * point at another workspace):
 *   npx tsx src/workflows/fit-functional/guided/index.ts
 */
import { isMain, runCli } from "../../../lib/cli.js";
import { FIT_PERFORMER, JVM_CLIENTS } from "../../../lib/repos.js";
import { rootDirFromArgv } from "../../../lib/root.js";
import { chooseSdk } from "../../../steps/choose-sdk.js";
import { ensureRepo } from "../../../steps/ensure-repo.js";
import { selectOrCreateCluster } from "../../cluster-select-or-create/index.js";
import { ensureFitGrpc } from "../steps/ensure-fit-grpc.js";
import { generateFitConfiguration } from "../steps/generate-fit-configuration.js";
import { checkPerformer } from "../steps/performers/check-performer.js";

/** Walk through everything needed to run FIT functional tests for one SDK. */
export async function runFunctionalTests(rootDir: string): Promise<void> {
  // FIT itself must be present.
  if (!(await ensureRepo(FIT_PERFORMER, rootDir))) {
    console.log("\nOnce transactions-fit-performer is in place, run fit-cli again.");
    return;
  }

  // fit-grpc must be built into the local Maven repo.
  if (!(await ensureFitGrpc(rootDir))) {
    console.log("\nOnce fit-grpc is built, run fit-cli again.");
    return;
  }

  // Which SDK to test, and whether its performer is present.
  const sdk = await chooseSdk();
  checkPerformer(sdk, rootDir);

  // JVM SDKs additionally need couchbase-jvm-clients.
  if (sdk.jvm) {
    console.log(`\n${sdk.name} is a JVM SDK, so it needs couchbase-jvm-clients.`);
    if (!(await ensureRepo(JVM_CLIENTS, rootDir))) {
      console.log("\nOnce couchbase-jvm-clients is in place, run fit-cli again.");
      return;
    }
  }

  // Existing cluster, or create a new one with cbdinocluster.
  const outcome = await selectOrCreateCluster();
  if (!outcome.ready) {
    return;
  }
  generateFitConfiguration(outcome.cluster, rootDir);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    await runFunctionalTests(rootDir);
  });
}
