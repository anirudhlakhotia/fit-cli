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
 *   npx tsx src/workflows/cluster-select-or-create/index.ts
 */
import { confirm } from "../../util/non-fit/prompts.js";
import { type ArtifactCollection } from "../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { createCluster } from "../cluster-create/index.js";
import { runClusterDiag } from "../cluster-diag/index.js";
import { selectCluster, type SelectedCluster } from "../cluster-select/index.js";

/** The outcome of getting a cluster to use. */
export type ClusterOutcome =
  /** An existing cluster was selected and is ready to use. */
  | (ArtifactCollection & { ready: true; cluster: SelectedCluster })
  /** No cluster is ready to use; the reason was already printed. */
  | (ArtifactCollection & { ready: false });

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
    });
    if (shouldRunDiag && !(await runClusterDiag(selection.cluster))) {
      return { ready: false, artifacts: [] };
    }
    return { ready: true, cluster: selection.cluster, artifacts: [] };
  }

  // mode === "create": allocate a fresh cluster with cbdinocluster.
  const result = await createCluster();
  if (!result.created) {
    console.log("\nOnce you have a cluster, run fit-cli again.");
    return { ready: false, artifacts: result.artifacts };
  }

  // A freshly-allocated cluster still needs its connection string and credentials
  // pulled from cbdinocluster before it can be used; that's a future step, so for
  // now point the user back through the existing-cluster path.
  console.log(
    "\nYour cluster is allocated. Re-run fit-cli and choose the existing-cluster path " +
      "with its connection string.",
  );
  return { ready: false, artifacts: result.artifacts };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const outcome = await selectOrCreateCluster();
    process.exit(outcome.ready ? 0 : 1);
  });
}
