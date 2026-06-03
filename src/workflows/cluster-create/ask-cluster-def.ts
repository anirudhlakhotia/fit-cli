/**
 * Step: ask the user what cluster they want cbdinocluster to allocate — the
 * cluster type, node count, Couchbase version, services, and whether they want
 * CNG/Protostellar support. Pure prompting; turning the answers into the YAML
 * def lives in build-cluster-def.ts.
 *
 * Run on its own:
 *   npx tsx src/workflows/cluster-create/ask-cluster-def.ts
 *
 * Prints the gathered answers as JSON.
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { checkbox, confirm, input, number, select } from "../../util/non-fit/prompts.js";
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

/** Ask the questions that describe the cluster to allocate. */
export async function askClusterDef(): Promise<ClusterDef> {
  // Only one cluster type for now, but we still ask so adding more later is
  // natural — and so the limitation is visible.
  await select({
    promptId: "cluster.create.type",
    message: "What type of cluster would you like?",
    choices: [
      {
        name: "Operational (with optional CNG support)",
        value: "operational",
        description:
          "Only operational clusters are supported for now — please feel welcome to add support for other cluster types.",
      },
    ],
  });

  const nodeCount =
    (await number({ promptId: "cluster.create.node-count", message: "How many nodes?", default: 1, min: 1 })) ??
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

  const cng = await confirm({
    promptId: "cluster.create.cng",
    message: "Do you want CNG/Protostellar (Cloud Native Gateway) support?",
    default: false,
  });

  return { nodeCount, version, services, cng };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    console.log(JSON.stringify(await askClusterDef(), null, 2));
  });
}
