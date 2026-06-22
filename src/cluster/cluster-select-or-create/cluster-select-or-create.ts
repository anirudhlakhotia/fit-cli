/**
 * Workflow: get a cluster to use, either by selecting an existing one or by
 * creating a fresh one with cbdinocluster. Composes the cluster-select and
 * cluster-create workflows so callers don't have to juggle the select-vs-create
 * branching themselves.
 *
 * This workflow knows nothing about FIT configuration; turning a SelectedCluster
 * into a FITConfiguration lives under src/workflows/fit-functional/.
 *
 * Run this workflow on its own:
 *   bun src/cluster/cluster-select-or-create/cluster-select-or-create.ts
 */
import { confirm } from "../../util/non-fit/prompts.js";
import { type RunOutput } from "../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { createCluster } from "../cluster-create/cluster-create.js";
import { runClusterDiag } from "../cluster-diag/cluster-diag.js";
import { classifyConnectionString } from "../cluster-select/classify-connection-string.js";
import { buildSelectedCluster, selectCluster, type SelectedCluster } from "../cluster-select/cluster-select.js";

/** The outcome of getting a cluster to use. */
export type ClusterOutcome =
  /** An existing cluster was selected and is ready to use. */
  | (RunOutput & { ready: true; cluster: SelectedCluster })
  /** No cluster is ready to use; the reason was already printed. */
  | (RunOutput & { ready: false });

/**
 * Get a cluster to use: select an existing one (ready straight away) or create a
 * new one with cbdinocluster. Any user-facing explanation is printed along the
 * way; the boolean just says whether a cluster is ready to use.
 */
export async function selectOrCreateCluster(): Promise<ClusterOutcome> {
  const selection = await selectCluster();
  if (selection.mode === "existing") {
    const shouldRunDiag = await confirm({
      promptId: "cluster.diag.run-now",
      message: "Sanity test the cluster now?",
      default: true,
    }, { clearPromptOnDone: true });
    if (shouldRunDiag && !(await runClusterDiag(selection.cluster))) {
      return { ready: false, artifacts: [], details: [] };
    }
    return { ready: true, cluster: selection.cluster, artifacts: [], details: [] };
  }

  // mode === "create": allocate a fresh cluster with cbdinocluster, then carry on
  // with its connection string just as if the user had selected an existing one.
  const result = await createCluster();
  if (!result.created) {
    console.log("\nOnce you have a cluster, run fit-cli again.");
    return { ready: false, artifacts: result.artifacts, details: result.details };
  }

  const classification = classifyConnectionString(result.connectionString);
  if (classification.kind !== "supported") {
    console.log(
      `\nYour cluster is allocated, but its connection string (${result.connectionString}) isn't ` +
        "one this tool can use directly. Re-run fit-cli and choose the existing-cluster path.",
    );
    return { ready: false, artifacts: result.artifacts, details: result.details };
  }

  console.log(`\n✓ Using your new cluster at ${result.connectionString}`);
  const cluster = await buildSelectedCluster(classification);
  return { ready: true, cluster, artifacts: result.artifacts, details: result.details };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const outcome = await selectOrCreateCluster();
    process.exit(outcome.ready ? 0 : 1);
  });
}
