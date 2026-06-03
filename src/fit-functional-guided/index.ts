/**
 * The "Run functional tests" guided flow. This orchestrates the steps needed to
 * run FIT functional tests for one SDK. Generic steps it reuses live under
 * src/steps/ and src/lib/; the steps specific to this flow live under
 * ./steps/ alongside this file.
 *
 * Run this flow on its own (skipping the top-level menu):
 *   npx tsx src/fit-functional-guided/index.ts
 */
import { isMain, runCli } from "../lib/cli.js";
import { FIT_PERFORMER, JVM_CLIENTS } from "../lib/repos.js";
import { chooseCluster } from "../steps/choose-cluster.js";
import { chooseSdk } from "../steps/choose-sdk.js";
import { ensureRepo } from "../steps/ensure-repo.js";
import { ensureFitGrpc } from "./steps/ensure-fit-grpc.js";
import { checkPerformer } from "./steps/performers/check-performer.js";

/** Walk through everything needed to run FIT functional tests for one SDK. */
export async function runFunctionalTests(): Promise<void> {
  // FIT itself must be present.
  if (!(await ensureRepo(FIT_PERFORMER))) {
    console.log("\nOnce transactions-fit-performer is in place, run fit-cli again.");
    return;
  }

  // fit-grpc must be built into the local Maven repo.
  if (!(await ensureFitGrpc())) {
    console.log("\nOnce fit-grpc is built, run fit-cli again.");
    return;
  }

  // Which SDK to test, and whether its performer is present.
  const sdk = await chooseSdk();
  checkPerformer(sdk);

  // JVM SDKs additionally need couchbase-jvm-clients.
  if (sdk.jvm) {
    console.log(`\n${sdk.name} is a JVM SDK, so it needs couchbase-jvm-clients.`);
    if (!(await ensureRepo(JVM_CLIENTS))) {
      console.log("\nOnce couchbase-jvm-clients is in place, run fit-cli again.");
      return;
    }
  }

  // Existing cluster, or create a new one.
  const cluster = await chooseCluster();
  console.log(
    `\nGreat — testing the ${sdk.name} SDK with ${
      cluster === "existing" ? "your existing cluster" : "a new cluster"
    }.`,
  );
  console.log("(Cluster setup and test execution will be wired up in a later step.)");
}

if (isMain(import.meta.url)) {
  runCli(runFunctionalTests);
}
