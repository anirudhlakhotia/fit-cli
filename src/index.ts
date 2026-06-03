#!/usr/bin/env node
import { confirm, select } from "@inquirer/prompts";
import {
  buildFit,
  cloneRepo,
  fitGrpcStatus,
  performerExists,
  performerPath,
  repoExists,
  repoPath,
  FIT_PERFORMER,
  JVM_CLIENTS,
  type Repo,
} from "./repos.js";

/**
 * SDKs that FIT can test. The JVM-based ones share couchbase-jvm-clients and
 * the single "java" performer. `performer` is the SDK's directory under
 * transactions-fit-performer/performers.
 */
const SDKS = [
  { name: "Java", value: "java", jvm: true, performer: "java" },
  { name: "Scala", value: "scala", jvm: true, performer: "scala" },
  { name: "Kotlin", value: "kotlin", jvm: true, performer: "kotlin" },
  { name: "C++", value: "cpp", jvm: false, performer: "cpp" },
  { name: ".NET", value: "dotnet", jvm: false, performer: "dotnet" },
  { name: "Go", value: "go", jvm: false, performer: "go" },
  { name: "Node.js", value: "node", jvm: false, performer: "node" },
  { name: "Python", value: "python", jvm: false, performer: "python" },
  { name: "Ruby", value: "ruby", jvm: false, performer: "ruby" },
  { name: "Rust", value: "rust", jvm: false, performer: "rust" },
] as const;

type Sdk = (typeof SDKS)[number];

/**
 * Make sure a sibling repo is present. If it is missing, offer to clone it,
 * otherwise let the user exit so they can sort it out themselves.
 *
 * @returns true if the repo is ready to use, false if the user chose to exit.
 */
async function ensureRepo(repo: Repo): Promise<boolean> {
  if (repoExists(repo)) {
    console.log(`✓ Found ${repo.name} at ${repoPath(repo)}`);
    return true;
  }

  console.log(`✗ Could not find ${repo.name} at ${repoPath(repo)}`);

  const action = await select({
    message: `What would you like to do about the missing ${repo.name}?`,
    choices: [
      { name: `Clone it from ${repo.url}`, value: "clone" },
      { name: "Exit so I can sort it out myself", value: "exit" },
    ],
  });

  if (action === "exit") {
    return false;
  }

  console.log(`\nCloning ${repo.name}...\n`);
  try {
    await cloneRepo(repo);
    console.log(`\n✓ Cloned ${repo.name} to ${repoPath(repo)}`);
    return true;
  } catch (err) {
    console.error(`\n✗ Failed to clone ${repo.name}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Make sure fit-grpc is available and reasonably fresh in the local Maven repo.
 * If it is missing or over a month old, offer to build FIT (which installs
 * fit-grpc into ~/.m2).
 *
 * @returns true if fit-grpc is ready to use, false if the user chose to exit.
 */
async function ensureFitGrpc(): Promise<boolean> {
  const status = fitGrpcStatus();

  if (status.present && status.upToDate) {
    console.log(
      `✓ fit-grpc is in your local Maven repo (built ${status.builtAt!.toLocaleDateString()})`,
    );
    return true;
  }

  if (status.present) {
    console.log(
      `! fit-grpc is in your local Maven repo but is over a month old (built ${status.builtAt!.toLocaleDateString()})`,
    );
  } else {
    console.log("✗ fit-grpc is not in your local Maven repo");
  }

  console.log(
    "\nBuilding FIT will run:\n" +
      "  cd ../transactions-fit-performer && mvn clean install -Dmaven.test.skip\n\n" +
      "This builds fit-grpc (the JVM build of the GRPC) and puts it into your local Maven repo.\n" +
      "If the GRPC ever changes, you'll need to rerun that mvn step again.",
  );

  const build = await confirm({ message: "Build FIT now?" });
  if (!build) {
    return false;
  }

  console.log("\nBuilding FIT...\n");
  try {
    await buildFit();
    console.log("\n✓ Built FIT — fit-grpc is now in your local Maven repo");
    return true;
  } catch (err) {
    console.error(`\n✗ Failed to build FIT: ${(err as Error).message}`);
    return false;
  }
}

/** Run the "Run functional tests" wizard. */
async function runFunctionalTests(): Promise<void> {
  // Step 1: FIT itself must be present.
  if (!(await ensureRepo(FIT_PERFORMER))) {
    console.log("\nOnce transactions-fit-performer is in place, run fit-cli again.");
    return;
  }

  // Step 2: fit-grpc must be built into the local Maven repo.
  if (!(await ensureFitGrpc())) {
    console.log("\nOnce fit-grpc is built, run fit-cli again.");
    return;
  }

  // Step 3: which SDK to test.
  const sdkValue = await select<Sdk["value"]>({
    message: "Which SDK do you want to test?",
    choices: SDKS.map((sdk) => ({ name: sdk.name, value: sdk.value })),
  });
  const sdk = SDKS.find((s) => s.value === sdkValue)!;

  // The SDK's performer must exist within transactions-fit-performer.
  if (performerExists(sdk.performer)) {
    console.log(`✓ Found the ${sdk.name} performer at ${performerPath(sdk.performer)}`);
  } else {
    console.log(`✗ Could not find the ${sdk.name} performer at ${performerPath(sdk.performer)}`);
  }

  // Step 4: JVM SDKs need couchbase-jvm-clients.
  if (sdk.jvm) {
    console.log(`\n${sdk.name} is a JVM SDK, so it needs couchbase-jvm-clients.`);
    if (!(await ensureRepo(JVM_CLIENTS))) {
      console.log("\nOnce couchbase-jvm-clients is in place, run fit-cli again.");
      return;
    }
  }

  // Step 5: cluster.
  const cluster = await select({
    message: "Do you already have a Couchbase cluster running?",
    choices: [
      { name: "Yes, I have a cluster running already", value: "existing" },
      { name: "No, I want to create one", value: "create" },
    ],
  });

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

main().catch((err) => {
  // A clean Ctrl-C / Esc from @inquirer throws ExitPromptError; treat as a quiet exit.
  if (err instanceof Error && err.name === "ExitPromptError") {
    console.log("\nCancelled.");
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});
