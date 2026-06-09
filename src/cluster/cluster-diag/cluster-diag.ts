/**
 * Workflow: sanity-test a selected Couchbase cluster by querying its management
 * endpoint with curl.
 *
 * Run on its own:
 *   npx tsx src/cluster/cluster-diag/cluster-diag.ts couchbase://127.0.0.1 Administrator password
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { capture, type RunOptions } from "../../util/non-fit/proc.js";
import type { SelectedCluster } from "../cluster-select/cluster-select.js";
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

export interface ClusterDiagOptions {
  /** How long to keep retrying before giving up, in milliseconds. Defaults to 30 000 (30 s). */
  retryTimeoutMs?: number;
  /**
   * The function used to run curl. Defaults to the local `capture()`.
   * Pass `execution.capture` when the cluster is only reachable from a remote
   * execution target (e.g. an EC2 instance) so curl runs there instead of locally.
   */
  captureCommand?: (command: string, args: string[], cwd?: string, opts?: RunOptions) => Promise<string>;
}

/** Run a quick curl-based sanity check against the cluster's management endpoint.
 *  Retries with exponential backoff (up to 5 s per sleep) for up to retryTimeoutMs. */
export async function runClusterDiag(cluster: SelectedCluster, opts?: ClusterDiagOptions): Promise<boolean> {
  const url = clusterDiagUrl(cluster);
  const command = `curl -k -u <username>:<password> -X GET ${url}`;
  const retryTimeoutMs = opts?.retryTimeoutMs ?? 30_000;
  const captureCommand = opts?.captureCommand ?? capture;
  const deadline = Date.now() + retryTimeoutMs;
  let delayMs = 500;
  let attempt = 0;

  while (true) {
    try {
      // For convenience in testing e.g. Capella, always use -k (insecure).
      // Use quiet on retries to avoid spamming the terminal with repeated curl echoes.
      await captureCommand(
        "curl",
        ["-k", "-u", `${cluster.credentials.username}:${cluster.credentials.password}`, "-X", "GET", url],
        undefined,
        attempt > 0 ? { quiet: true } : undefined,
      );
      console.log(`\n✓ Cluster sanity test succeeded with:\n  ${command}`);
      return true;
    } catch (err) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        console.error(`\nSanity-testing the cluster with:\n  ${command}\n`);
        console.error(`\n✗ Cluster sanity test failed: ${(err as Error).message}`);
        return false;
      }
      const waitMs = Math.min(delayMs, remaining, 5_000);
      console.error(`  Cluster not ready yet (${(err as Error).message}), retrying in ${(waitMs / 1000).toFixed(1)}s (${Math.ceil(remaining / 1000)}s remaining)...`);
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      delayMs = Math.min(delayMs * 2, 5_000);
      attempt++;
    }
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const raw = process.argv[2];
    const username = process.argv[3];
    const password = process.argv[4];

    if (!raw || !username || !password) {
      console.error(
        "Usage: tsx src/workflows/cluster-diag/cluster-diag.ts <connection-string> <username> <password>",
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
