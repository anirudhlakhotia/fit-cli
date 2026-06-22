/**
 * Step: ask what the definition should do if cbdinocluster already has a cluster
 * running when its setup-cluster step runs. The answer is written into the
 * definition's `cbdinocluster.onClusterExists` field; the policy itself lives in
 * cluster-exists-policy.ts.
 *
 * Run on its own:
 *   bun src/cluster/cluster-create/ask-cluster-exists-policy.ts
 *
 * Prints the chosen policy.
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { select } from "../../util/non-fit/prompts.js";
import {
  DEFAULT_CLUSTER_EXISTS_POLICY,
  type ClusterExistsPolicy,
} from "./cluster-exists-policy.js";

/** Ask which cluster-exists policy to record in the definition. */
export async function askClusterExistsPolicy(): Promise<ClusterExistsPolicy> {
  return select<ClusterExistsPolicy>({
    promptId: "cluster.create.on-cluster-exists",
    message:
      "If cbdinocluster already has a cluster running when this definition runs, what should happen?",
    choices: [
      {
        name: "destroyAndRecreate — remove any existing cluster(s) and allocate a fresh one (good for clean testing, slower)",
        value: "destroyAndRecreate",
      },
      {
        name: "useExisting — trust the running cluster is the right one and test against it (convenient for efficient local test iteration)",
        value: "useExisting",
      },
      {
        name: "fail — stop the run rather than touch an existing cluster",
        value: "fail",
      },
    ],
    default: DEFAULT_CLUSTER_EXISTS_POLICY,
  });
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    console.log(await askClusterExistsPolicy());
  });
}
