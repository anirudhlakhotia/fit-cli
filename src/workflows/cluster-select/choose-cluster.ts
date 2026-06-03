/**
 * Step: ask whether to use an existing Couchbase cluster or create a new one.
 *
 * Run on its own:
 *   npx tsx src/workflows/cluster-select/choose-cluster.ts
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
      { name: "Yes, I have a cluster running already", value: "existing" },
      { name: "No, I want to create one with cbdinocluster", value: "create" },
    ],
  });
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const choice = await chooseCluster();
    console.log(choice);
  });
}
