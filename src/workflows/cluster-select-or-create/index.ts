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
import { isMain, runCli } from "../../lib/cli.js";
import { createCluster } from "../cluster-create/index.js";
import { selectCluster, type SelectedCluster } from "../cluster-select/index.js";

/** The outcome of getting a cluster to use. */
export type ClusterOutcome =
  /** An existing cluster was selected and is ready to use. */
  | { ready: true; cluster: SelectedCluster }
  /** No cluster is ready to use; the reason was already printed. */
  | { ready: false };

/**
 * Get a cluster to use: select an existing one (ready straight away) or create a
 * new one with cbdinocluster. Any user-facing explanation is printed along the
 * way; the boolean just says whether a cluster is ready to use.
 */
export async function selectOrCreateCluster(): Promise<ClusterOutcome> {
  const selection = await selectCluster();
  if (selection.mode === "existing") {
    return { ready: true, cluster: selection.cluster };
  }

  // mode === "create": allocate a fresh cluster with cbdinocluster.
  const result = await createCluster();
  if (!result.created) {
    console.log("\nOnce you have a cluster, run fit-cli again.");
    return { ready: false };
  }

  // A freshly-allocated cluster still needs its connection string and credentials
  // pulled from cbdinocluster before it can be used; that's a future step, so for
  // now point the user back through the existing-cluster path.
  console.log(
    "\nYour cluster is allocated. Re-run fit-cli and choose the existing-cluster path " +
      "with its connection string.",
  );
  return { ready: false };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const outcome = await selectOrCreateCluster();
    process.exit(outcome.ready ? 0 : 1);
  });
}
