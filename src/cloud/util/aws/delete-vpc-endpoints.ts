/**
 * delete-vpc-endpoints — clean up the AWS VPC (PrivateLink) endpoint(s) that
 * cbdinocluster's `private-endpoints setup-link` created for a Capella cluster.
 *
 * cbdinocluster only auto-deletes endpoints left in "rejected"/"failed" state
 * (its own `cleanup` command); a successfully-linked ("available") endpoint is
 * never torn down by cbdinocluster itself, so fit-cli must delete it explicitly
 * on cluster teardown — otherwise every PE run leaks a paid VPC endpoint.
 *
 * cbdinocluster tags every endpoint it creates with `Cbdc2ClusterId=<CloudClusterID>`
 * (see CreateVPCEndpoint in cbdinocluster's awscontrol package) — the Couchbase
 * cluster's own UUID, *not* cbdinocluster's own tracking id (the one used for
 * connstr/remove). We look the endpoint up by that tag rather than needing the
 * endpoint id from setup-link's output.
 *
 * Run on its own:
 *   bun src/cloud/util/aws/delete-vpc-endpoints.ts --couchbase-cluster-uuid <capella-cluster-uuid>
 */
import { DeleteVpcEndpointsCommand, DescribeVpcEndpointsCommand } from "@aws-sdk/client-ec2";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { logAwsAction, prepareAwsCli } from "./aws-cli.js";
import { ec2Client } from "./aws-clients.js";

/**
 * Delete any VPC endpoint(s) tagged with the given Couchbase cluster UUID (see
 * module doc — this is *not* cbdinocluster's own cluster id).
 * Best-effort: this is cleanup, not part of the run's success/failure — a
 * failure here shouldn't fail the whole teardown.
 */
export async function deleteVpcEndpointsForCluster(couchbaseClusterUuid: string): Promise<void> {
  const described = await ec2Client.send(
    new DescribeVpcEndpointsCommand({ Filters: [{ Name: "tag:Cbdc2ClusterId", Values: [couchbaseClusterUuid] }] }),
  );
  const endpointIds = (described.VpcEndpoints ?? [])
    .map((endpoint) => endpoint.VpcEndpointId)
    .filter((id): id is string => id !== undefined);
  if (endpointIds.length === 0) {
    return;
  }
  console.log(`  deleting VPC endpoint(s) for cluster ${couchbaseClusterUuid}: ${endpointIds.join(", ")}`);
  await ec2Client.send(new DeleteVpcEndpointsCommand({ VpcEndpointIds: endpointIds }));
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    const idIndex = argv.indexOf("--couchbase-cluster-uuid");
    const couchbaseClusterUuid = idIndex !== -1 ? argv[idIndex + 1] : undefined;
    if (!couchbaseClusterUuid) {
      throw new Error("Usage: delete-vpc-endpoints.ts --couchbase-cluster-uuid <capella-cluster-uuid>");
    }
    await prepareAwsCli();
    logAwsAction("Deleting VPC endpoint(s)", { couchbaseClusterUuid });
    await deleteVpcEndpointsForCluster(couchbaseClusterUuid);
    console.log(`✓ Done`);
  });
}
