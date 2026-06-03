#!/usr/bin/env node
/**
 * The FIT CLI wizard. This file only orchestrates the flow — each individual
 * step lives in its own file under steps/ and can be run on its own for
 * debugging (see the header of each step file for how).
 */
import { select } from "@inquirer/prompts";
import { runCli } from "./lib/cli.js";
import { FIT_PERFORMER, JVM_CLIENTS } from "./lib/repos.js";
import { checkPerformer } from "./steps/check-performer.js";
import { chooseCluster } from "./steps/choose-cluster.js";
import { chooseSdk } from "./steps/choose-sdk.js";
import { ensureFitGrpc } from "./steps/ensure-fit-grpc.js";
import { ensureRepo } from "./steps/ensure-repo.js";

/** Walk through everything needed to run FIT functional tests for one SDK. */
async function runFunctionalTests(): Promise<void> {
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

async function main(): Promise<void> {
  console.log("FIT CLI — making FIT easier to use.\n");

  const choice = await select({
    message: "What would you like to do?",
    choices: [
      { name: "Run functional tests", value: "functional-tests" },
      // More options will follow.
    ],
  });

  switch (choice) {
    case "functional-tests":
      await runFunctionalTests();
      break;
  }
}

runCli(main);
