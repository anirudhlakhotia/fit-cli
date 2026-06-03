/**
 * Workflow: select a Couchbase cluster to use. Reusable across features that
 * need a cluster — it asks whether to use an existing cluster or create one, and
 * for an existing cluster gathers its connection string, credentials and (for
 * couchbases://) TLS choice into a {@link SelectedCluster}.
 *
 * This workflow knows nothing about FIT configuration — turning a SelectedCluster
 * into a FITConfiguration lives under src/workflows/fit-functional/.
 *
 * Run this workflow on its own:
 *   npx tsx src/workflows/cluster-select/index.ts
 *
 * Prints the selection as JSON.
 */
import { isMain, runCli } from "../../lib/cli.js";
import { askConnectionString } from "./ask-connection-string.js";
import { askCredentials, type Credentials } from "./ask-credentials.js";
import { askTls, type TlsConfig } from "./ask-tls.js";
import type { ClusterFlavour } from "./classify-connection-string.js";
import { chooseCluster } from "./choose-cluster.js";

/** Everything needed to connect to an existing cluster. */
export interface SelectedCluster {
  scheme: "couchbase" | "couchbases";
  defaultHostname: string;
  flavour: ClusterFlavour;
  credentials: Credentials;
  tls: TlsConfig;
}

/** The outcome of the cluster-select workflow. */
export type ClusterSelection =
  | { mode: "existing"; cluster: SelectedCluster }
  /** The user wants to create a new cluster (not yet wired up anywhere). */
  | { mode: "create" };

/**
 * Walk the user through choosing a cluster. For an existing cluster this gathers
 * all the details needed to connect; for "create" it just records the intent.
 */
export async function selectCluster(): Promise<ClusterSelection> {
  const choice = await chooseCluster();
  if (choice === "create") {
    return { mode: "create" };
  }

  const connection = await askConnectionString();
  const credentials = await askCredentials();
  // couchbase:// is non-TLS; only couchbases:// needs a TLS decision.
  const tls: TlsConfig =
    connection.scheme === "couchbases" ? await askTls(connection.flavour) : null;

  return {
    mode: "existing",
    cluster: {
      scheme: connection.scheme,
      defaultHostname: connection.defaultHostname,
      flavour: connection.flavour,
      credentials,
      tls,
    },
  };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const selection = await selectCluster();
    console.log(JSON.stringify(selection, null, 2));
  });
}
