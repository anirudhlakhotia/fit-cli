/**
 * Workflow: create a new Couchbase cluster with cbdinocluster. Reusable by any
 * feature that needs a fresh cluster — it makes sure cbdinocluster is usable,
 * asks what cluster to build, writes a def file under /tmp and allocates it.
 *
 * This workflow knows nothing about FIT configuration; it's the create-side
 * counterpart to the cluster-select workflow.
 *
 * Run this workflow on its own (this really does allocate a cluster):
 *   npx tsx src/workflows/cluster-create/index.ts
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { allocateCluster, askDeployer } from "./allocate-cluster.js";
import { askClusterDef } from "./ask-cluster-def.js";
import { buildClusterDef } from "./build-cluster-def.js";
import { ensureCbdinocluster } from "./ensure-cbdinocluster.js";

/** The outcome of attempting to create a cluster. */
export type CreateResult =
  /** cbdinocluster allocated the cluster successfully. */
  | { created: true }
  /** cbdinocluster wasn't usable or allocation failed; a reason was printed. */
  | { created: false };

/**
 * Walk the user through creating a cluster with cbdinocluster. Returns whether a
 * cluster was allocated; the user-facing explanation of any failure is printed
 * along the way.
 */
export async function createCluster(): Promise<CreateResult> {
  const cbdinocluster = await ensureCbdinocluster();
  if (!cbdinocluster) {
    return { created: false };
  }

  const def = buildClusterDef(await askClusterDef());
  const deployer = await askDeployer();

  try {
    await allocateCluster(cbdinocluster, def, deployer);
    console.log("\n✓ cbdinocluster allocated your cluster");
    return { created: true };
  } catch (err) {
    console.error(`\n✗ cbdinocluster failed to allocate the cluster: ${(err as Error).message}`);
    return { created: false };
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const result = await createCluster();
    process.exit(result.created ? 0 : 1);
  });
}
