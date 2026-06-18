/**
 * Enable a cao-deployer (CNG / OpenShift) cluster's ingresses after allocate.
 * cbdinocluster allocates the cluster but leaves its data and REST planes
 * unexposed; `cbdinocluster ingresses enable <id>` publishes the OpenShift routes,
 * which is what makes the performer's couchbase2 connection string resolvable.
 *
 * (The default bucket is left to the FIT test-driver — fit-cli no longer creates
 * it via REST.)
 *
 * Run on its own:
 *   npx tsx src/cluster/cluster-create/cao-ingress.ts <cluster-id>
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { localClusterCommandExecutor, type ClusterCommandExecutor } from "./allocate-cluster.js";

/** Enable the cluster's ingresses so its data and REST planes are reachable. */
export async function enableIngresses(
  cbdinocluster: string,
  clusterId: string,
  execution: ClusterCommandExecutor,
): Promise<void> {
  console.log(`→ setup-cluster: enabling ingresses for cao cluster ${clusterId}…`);
  await execution.run(cbdinocluster, ["ingresses", "enable", clusterId], undefined, {
    display: `cbdinocluster ingresses enable ${clusterId}`,
  });
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const [clusterId] = process.argv.slice(2);
    if (!clusterId) {
      console.error("Usage:\n  cao-ingress.ts <cluster-id>");
      process.exit(2);
    }
    await enableIngresses("cbdinocluster", clusterId, localClusterCommandExecutor());
  });
}
