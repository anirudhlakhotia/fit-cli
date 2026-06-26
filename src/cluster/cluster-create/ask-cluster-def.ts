/**
 * Step: ask the user what cluster they want cbdinocluster to allocate — the
 * cluster type, node count, Couchbase version and services. Pure prompting;
 * turning the answers into the YAML def lives in build-cluster-def.ts.
 *
 * Whether the cluster should add CNG/Protostellar (Cloud Native Gateway) support
 * is *not* asked here — the caller decides it (the definition builder asks
 * "operational vs CNG" when adding functional testing) and passes it in.
 *
 * Run on its own (add --cng to build a CNG cluster def):
 *   bun src/cluster/cluster-create/ask-cluster-def.ts
 *   bun src/cluster/cluster-create/ask-cluster-def.ts --cng
 *
 * Prints the gathered answers as JSON.
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { printWithoutTimestamps } from "../../util/non-fit/fit-cli-log.js";
import { checkbox, input, number } from "../../util/non-fit/prompts.js";
import { loadEnvironments } from "../../fit/util/environments.js";
import { type ClusterDef } from "./build-cluster-def.js";

/** Services offered, with the FIT-typical set selected by default. */
const SERVICES = [
  { name: "kv (Data)", value: "kv", checked: true },
  { name: "n1ql (Query)", value: "n1ql", checked: true },
  { name: "index (Index)", value: "index", checked: true },
  { name: "fts (Search)", value: "fts", checked: true },
  { name: "cbas (Analytics)", value: "cbas", checked: false },
  { name: "eventing (Eventing)", value: "eventing", checked: false },
  { name: "backup (Backup)", value: "backup", checked: false },
];

/** Options controlling what {@link askClusterDef} produces. */
export interface AskClusterDefOptions {
  /**
   * Build a CNG/Protostellar (Cloud Native Gateway) cluster — adds the `cao`
   * block to the cbdinocluster def. The connectivity choice is made one level up
   * (the definition builder's "operational vs CNG" prompt), so this is passed in
   * rather than asked here.
   */
  cng?: boolean;
  /**
   * Build a self-managed Enterprise Analytics cluster — emits cbdinocluster's
   * `columnar: true` flag (cbdino's historical name) plus an nginx load balancer.
   * Decided one level up (the "what to test against" prompt), so it's passed in.
   * cbdino derives the Analytics topology, so no service list is asked.
   */
  enterpriseAnalytics?: boolean;
}

/** Ask the questions that describe the cluster to allocate. */
export async function askClusterDef(options: AskClusterDefOptions = {}): Promise<ClusterDef> {
  const defaults = loadEnvironments().defaults;

  if (options.cng) {
    console.log("\nNote: CNG (Cloud Native Gateway) will be automatically installed as CNG testing was requested.\n");
  }

  if (options.enterpriseAnalytics) {
    console.log("\nNote: building a self-managed Enterprise Analytics cluster (cbdinocluster, fronted by an nginx load balancer).\n");
    const nodeCount =
      (await number({ promptId: "cluster.create.node-count", message: "How many nodes?", default: 3, min: 1 })) ?? 1;
    printWithoutTimestamps("  Enterprise Analytics builds: e.g. 2.2.0-1166");
    const version = await input({
      promptId: "cluster.create.server-version",
      message: "Which Enterprise Analytics version?",
      default: defaults.enterpriseAnalyticsVersion,
    });
    // cbdinocluster derives the Analytics topology from `columnar: true`, so no service list.
    return { nodeCount, version, services: [], cng: false, enterpriseAnalytics: true };
  }

  const nodeCount =
    (await number({ promptId: "cluster.create.node-count", message: "How many nodes?", default: 3, min: 1 })) ??
    1;

  if (options.cng) {
    // CNG on OpenShift pulls the server from cb-rhcc (not cb-vanilla), which only
    // carries specific certified builds — see defaults.cngClusterVersion in environments.json5.
    printWithoutTimestamps("  CNG server images (github.com/orgs/cb-rhcc/packages/container/package/server): e.g. 8.1.0-2222");
  } else {
    printWithoutTimestamps("  Alias (github.com/couchbaselabs/cb-alias): e.g. 8.0-stable");
    printWithoutTimestamps("  Server images (github.com/orgs/cb-vanilla/packages/container/package/server): e.g. 8.0.2-5322");
  }
  const version = await input({
    promptId: "cluster.create.server-version",
    message: "Which Couchbase Server version?",
    default: options.cng ? defaults.cngClusterVersion : defaults.clusterVersion,
  });

  const services = await checkbox<string>({
    promptId: "cluster.create.services",
    message: "Which services should the node(s) run?",
    choices: SERVICES,
  });

  return { nodeCount, version, services, cng: options.cng ?? false };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const cng = process.argv.slice(2).includes("--cng");
    console.log(JSON.stringify(await askClusterDef({ cng }), null, 2));
  });
}
