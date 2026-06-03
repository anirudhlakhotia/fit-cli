/**
 * Workflow: sanity-test a selected Couchbase cluster by querying its management
 * endpoint with curl.
 *
 * Run on its own:
 *   npx tsx src/workflows/cluster-diag/index.ts couchbase://127.0.0.1 Administrator password
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { run } from "../../util/non-fit/proc.js";
import type { SelectedCluster } from "../cluster-select/index.js";
import { classifyConnectionString } from "../cluster-select/classify-connection-string.js";

/** Build the curl URL for the cluster's management endpoint. */
export function clusterDiagUrl(cluster: SelectedCluster): string {
  const secure = cluster.scheme === "couchbases";
  const scheme = secure ? "https" : "http";
  const port = secure ? "18091" : "8091";
  const host = managementHost(cluster.defaultHostname);
  return `${scheme}://${host}:${port}/pools/default`;
}

function managementHost(defaultHostname: string): string {
  const firstHost = defaultHostname.split(",")[0]?.trim() ?? defaultHostname.trim();
  if (firstHost.startsWith("[")) {
    const bracket = firstHost.indexOf("]");
    return bracket === -1 ? firstHost : firstHost.slice(0, bracket + 1);
  }

  const colon = firstHost.indexOf(":");
  return colon === -1 ? firstHost : firstHost.slice(0, colon);
}

/** Run a quick curl-based sanity check against the cluster's management endpoint. */
export async function runClusterDiag(cluster: SelectedCluster): Promise<boolean> {
  const url = clusterDiagUrl(cluster);
  console.log(
    "\nSanity-testing the cluster with:\n" +
      `  curl -u <username>:<password> -X GET ${url}\n`,
  );

  try {
    await run("curl", ["-u", `${cluster.credentials.username}:${cluster.credentials.password}`, "-X", "GET", url]);
    console.log("\n✓ Cluster sanity test succeeded");
    return true;
  } catch (err) {
    console.error(`\n✗ Cluster sanity test failed: ${(err as Error).message}`);
    return false;
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const raw = process.argv[2];
    const username = process.argv[3];
    const password = process.argv[4];

    if (!raw || !username || !password) {
      console.error(
        "Usage: tsx src/workflows/cluster-diag/index.ts <connection-string> <username> <password>",
      );
      process.exit(2);
    }

    const connection = classifyConnectionString(raw);
    if (connection.kind !== "supported") {
      console.error("The connection string must use couchbase:// or couchbases://.");
      process.exit(2);
    }

    const ok = await runClusterDiag({
      scheme: connection.scheme,
      defaultHostname: connection.defaultHostname,
      flavour: connection.flavour,
      credentials: { username, password },
      tls: connection.scheme === "couchbases" ? { insecure: true } : null,
    });
    process.exit(ok ? 0 : 1);
  });
}
