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
import { FIT_PERFORMER } from "../../../lib/repos.js";
import { rootDirFromArgv } from "../../../lib/root.js";
import { chooseSdk } from "../../../steps/choose-sdk.js";
import { ensureRepo } from "../../../steps/ensure-repo.js";
import { ensureSdkWorkspace } from "../../../steps/ensure-sdk-workspace.js";
import { selectOrCreateCluster } from "../../cluster-select-or-create/index.js";
import { checkAndBuildPerformer } from "../../performers/check-and-build-performer/index.js";
import { ensureFitGrpc } from "../steps/ensure-fit-grpc.js";
import { generateFitConfiguration } from "../steps/generate-fit-configuration.js";

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

  // Which SDK to test, and whether its performer image is ready.
  const sdk = await chooseSdk();
  if (!(await ensureSdkWorkspace(sdk, rootDir))) {
    console.log("\nOnce the SDK workspace repos are in place, run fit-cli again.");
    return;
  }

  if (!(await checkAndBuildPerformer(rootDir, sdk))) {
    console.log("\nOnce the performer image is ready, run fit-cli again.");
    return;
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
