/**
 * Step: point the user at a self-managed (plain docker) cluster's Couchbase
 * web UI after it's created. Capella and CNG clusters already have their own
 * equivalents — capella-debug-links.ts's printCapellaUiLink, and the
 * `caoHosts.uiHost` fetched in allocate-cluster.ts — so this only fires for
 * the plain docker deployer, where cbdinocluster's connection string is the
 * container's own docker-network IP rather than anything Capella- or
 * CNG-specific.
 *
 * On Linux that IP is directly reachable from the host — Docker bridge
 * networks are routable without any `-p` port publishing — so a plain link
 * works there. When the cluster lives on a remote EC2 instance instead, only
 * that instance can reach the container IP, so an SSH local-port-forward
 * command is printed instead, reusing the identity file/host/user fit-cli
 * already generated for the box.
 *
 * Run on its own:
 *   bun src/cluster/cluster-diag/cluster-ui-link.ts couchbase://172.18.0.2
 *   bun src/cluster/cluster-diag/cluster-ui-link.ts couchbase://172.18.0.2 --remote 1.2.3.4 ubuntu ~/.ssh/key.pem
 */
import { createServer } from "node:net";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import type { SelectedCluster } from "../cluster-select/cluster-select.js";
import { classifyConnectionString } from "../cluster-select/classify-connection-string.js";
import { managementHostPort } from "./cluster-diag.js";

/**
 * Ask the OS for a currently-free local TCP port (bind to port 0, read back
 * what it picked, release it). Used for the tunnel's local port so the
 * suggested `-L` command doesn't collide with whatever's already bound to the
 * cluster's own port (very likely for 8091, if the user has other local
 * clusters or tunnels up). Falls back to a random port in the private range
 * if the probe itself fails (e.g. a sandboxed environment with no loopback).
 */
function freeLocalPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(49152 + Math.floor(Math.random() * 16384)));
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(() => resolve(port ?? 49152 + Math.floor(Math.random() * 16384)));
    });
  });
}

/** The SSH connection info needed to build a tunnel command to a remote box. */
export interface RemoteSshInfo {
  address: string;
  user: string;
  identityFile: string;
}

/**
 * Whether `cluster` is the plain self-managed docker cluster this applies to —
 * not CNG (own `caoHosts.uiHost`), not Capella (own `capellaUiUrl`), and not a
 * load-balanced Enterprise Analytics cluster (`analyticsLoadBalancerHost` points
 * at an nginx LB, not a Couchbase Server node — its 8091 admin console isn't
 * this straightforward, so leave it alone rather than print a misleading link).
 */
export function isDockerClusterUi(cluster: SelectedCluster): boolean {
  return cluster.flavour === "self-managed" && !cluster.cng && !cluster.analyticsLoadBalancerHost;
}

/**
 * Print how to reach the cluster's Couchbase UI in a browser: a direct link
 * when `remote` is omitted (the cluster runs on this machine), or an SSH
 * tunnel command when it runs on a remote box. No-op for Capella/CNG/EA clusters.
 */
export async function printClusterUiAccess(cluster: SelectedCluster, remote?: RemoteSshInfo): Promise<void> {
  if (!isDockerClusterUi(cluster)) {
    return;
  }
  const scheme = cluster.scheme === "couchbases" ? "https" : "http";
  const { host, port } = managementHostPort(cluster);
  const login = `  Login: ${cluster.credentials.username} / ${cluster.credentials.password}`;
  if (!remote) {
    // Docker bridge-network container IPs are only directly routable from the
    // host on Linux (Mac/Windows Docker Desktop NATs them) — see the caveat in
    // this file's header comment.
    const platformNote = process.platform === "linux" ? "" : " (only reachable this way on Linux)";
    console.log(`  Cluster UI: ${scheme}://${host}:${port}${platformNote}\n${login}`);
    return;
  }
  // The local port is independent of the cluster's own port — reusing it (e.g.
  // 8091) is likely to collide with something already bound locally.
  const localPort = await freeLocalPort();
  console.log(
    `  Cluster UI (on a remote box — open a tunnel first):\n` +
      `    ssh -i ${remote.identityFile} -L ${localPort}:${host}:${port} ${remote.user}@${remote.address}\n` +
      `    then browse to ${scheme}://localhost:${localPort}\n${login}`,
  );
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const [raw, remoteFlag, address, user, identityFile] = process.argv.slice(2);
    if (!raw) {
      console.error(
        "Usage: bun src/cluster/cluster-diag/cluster-ui-link.ts <connection-string> [--remote <address> <user> <identityFile>]",
      );
      process.exit(2);
    }
    const connection = classifyConnectionString(raw);
    if (connection.kind !== "supported") {
      console.error("The connection string must use couchbase:// or couchbases://.");
      process.exit(2);
    }
    const cluster: SelectedCluster = {
      scheme: connection.scheme,
      defaultHostname: connection.defaultHostname,
      flavour: connection.flavour,
      credentials: { username: "Administrator", password: "password" },
      tls: connection.scheme === "couchbases" ? { insecure: true } : null,
    };
    const remote =
      remoteFlag === "--remote" && address && user && identityFile ? { address, user, identityFile } : undefined;
    await printClusterUiAccess(cluster, remote);
  });
}
