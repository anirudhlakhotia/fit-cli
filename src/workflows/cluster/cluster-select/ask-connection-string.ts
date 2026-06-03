/**
 * Step: ask the user for their cluster's connection string, looping until they
 * give one this tool supports. For supported strings it announces which kind of
 * cluster was detected; for ones FIT supports but this tool doesn't (Enterprise
 * Analytics, Protostellar/CNG) it explains and re-prompts.
 *
 * Run on its own:
 *   npx tsx src/workflows/cluster-select/ask-connection-string.ts
 *
 * Prints the resulting supported classification as JSON.
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { input } from "../../../util/non-fit/prompts.js";
import { classifyConnectionString, type SupportedCluster } from "./classify-connection-string.js";

/** Tell the user which kind of cluster their (supported) string points at. */
function announce(cluster: SupportedCluster): void {
  switch (cluster.flavour) {
    case "internal-capella":
      console.log("→ An internal Capella cluster has been detected.");
      break;
    case "production-capella":
      console.log("→ This is a production Capella cluster.");
      break;
    case "self-managed":
      console.log("→ Treating this as a self-managed cluster.");
      break;
  }
}

/**
 * Prompt for a connection string, re-prompting until the user provides one this
 * tool can use. Returns the supported classification.
 */
export async function askConnectionString(): Promise<SupportedCluster> {
  let attempt = 1;
  for (;;) {
    const raw = await input({
      promptId: `cluster.connection-string.attempt-${attempt++}`,
      message:
        "Enter your cluster's full connection string, including the scheme (e.g. couchbase://localhost):",
    });

    const cluster = classifyConnectionString(raw);
    switch (cluster.kind) {
      case "supported":
        announce(cluster);
        return cluster;
      case "analytics":
        console.log(
          "This looks like an Enterprise Analytics connection string, which is supported by FIT " +
            "but not currently by this tool — PRs welcome ;)\n",
        );
        break;
      case "protostellar":
        console.log(
          "Protostellar/CNG clusters are supported by FIT but not currently by this tool — " +
            "PRs welcome ;)\n",
        );
        break;
      case "unsupported":
        console.log(
          "That connection string is unsupported. Supported schemes by this tool (FIT itself supports more) are couchbase://, " +
            "couchbases:// and couchbase2://. Please feel welcome to add support for other cluster types. Please make another choice.\n",
        );
        break;
    }
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const cluster = await askConnectionString();
    console.log(JSON.stringify(cluster, null, 2));
  });
}
