/**
 * Step: ask whether to use an existing Couchbase cluster or create a new one.
 *
 * Run on its own:
 *   bun src/cluster/cluster-select/choose-cluster.ts
 *
 * Prints the choice ("existing" or "create").
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { select } from "../../util/non-fit/prompts.js";

export type ClusterChoice = "existing" | "create";

export async function chooseCluster(): Promise<ClusterChoice> {
  return select<ClusterChoice>({
    promptId: "cluster.choose-mode",
    message: "Do you already have a Couchbase cluster running?",
    choices: [
      { name: "No, I want to create one with cbdinocluster", value: "create" },
      { name: "Yes, I have a cluster running already (for local testing)", value: "existing" },
    ],
  });
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const choice = await chooseCluster();
    console.log(choice);
  });
}
