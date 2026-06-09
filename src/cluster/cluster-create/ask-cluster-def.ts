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
 *   npx tsx src/cluster/cluster-create/ask-cluster-def.ts
 *   npx tsx src/cluster/cluster-create/ask-cluster-def.ts --cng
 *
 * Prints the gathered answers as JSON.
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { checkbox, input, number, select } from "../../util/non-fit/prompts.js";
import type { ClusterDef } from "./build-cluster-def.js";

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
}

/** Ask the questions that describe the cluster to allocate. */
export async function askClusterDef(options: AskClusterDefOptions = {}): Promise<ClusterDef> {
  if (options.cng) {
    console.log("\nNote: CNG (Cloud Native Gateway) will be automatically installed as CNG testing was requested.\n");
  }

  // Only one cluster type for now, but we still ask so adding more later is
  // natural — and so the limitation is visible.
  await select({
    promptId: "cluster.create.type",
    message: "What type of cluster would you like?",
    choices: [
      {
        name: "Operational",
        value: "operational",
      },
    ],
  });

  const nodeCount =
    (await number({ promptId: "cluster.create.node-count", message: "How many nodes?", default: 3, min: 1 })) ??
    1;

  const version = await input({
    promptId: "cluster.create.server-version",
    message: "Which Couchbase Server version?",
    default: "8.1.0-2188",
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
