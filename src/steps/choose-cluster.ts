/**
 * Step: ask whether to use an existing Couchbase cluster or create a new one.
 *
 * Run on its own:
 *   npx tsx src/steps/choose-cluster.ts
 *
 * Prints the choice ("existing" or "create").
 */
import { select } from "@inquirer/prompts";
import { isMain, runCli } from "../lib/cli.js";

export type ClusterChoice = "existing" | "create";

export async function chooseCluster(): Promise<ClusterChoice> {
  return select<ClusterChoice>({
    message: "Do you already have a Couchbase cluster running?",
    choices: [
      { name: "Yes, I have a cluster running already", value: "existing" },
      { name: "No, I want to create one", value: "create" },
    ],
  });
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const choice = await chooseCluster();
    console.log(choice);
  });
}
