/**
 * Step: allocate a cluster with cbdinocluster from a def document. The def is
 * written to a file in the current run directory under /tmp/fit-cli and then
 * handed to
 * `cbdinocluster --verbose allocate --def-file=<file>` (with an optional
 * --deployer override), whose output is streamed to the console.
 *
 * Run on its own (allocates a default single-node cluster — this really does
 * create a cluster, so only run it if you mean to):
 *   npx tsx src/workflows/cluster-create/allocate-cluster.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactFromPath, type ArtifactCollection, type Artifact } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { input } from "../../../util/non-fit/prompts.js";
import { runAndCapture } from "../../../util/non-fit/proc.js";
import { ensureRunDir } from "../../../util/non-fit/replay.js";
import { buildClusterDef } from "./build-cluster-def.js";
import { ensureCbdinocluster } from "./ensure-cbdinocluster.js";
import { parseAllocatedId } from "./parse-allocated-id.js";

/** A cluster cbdinocluster has just allocated. */
export type AllocatedCluster = ArtifactCollection & {
  /** The new cluster's UUID, as passed to `cbdinocluster connstr <id>`. */
  clusterId: string;
};

export interface WriteClusterDefResult {
  path: string;
  artifact: Artifact;
}

/**
 * Write the cbdinocluster def to a file in the current run directory and return
 * its absolute path. The run directory is already timestamped, so the filename
 * doesn't need to be.
 */
export function writeClusterDef(def: string, runDir: string = ensureRunDir()): WriteClusterDefResult {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const path = join(runDir, "cbdinocluster.yaml");
  writeFileSync(path, def);
  return {
    path,
    artifact: artifactFromPath(path, "cbdinocluster definition used to allocate the cluster", runDir),
  };
}

/**
 * Ask whether to override the cbdinocluster deployer, returning the override
 * string or undefined for "use the default". Empty input means no override.
 */
export async function askDeployer(): Promise<string | undefined> {
  const deployer = (
    await input({
      promptId: "cluster.create.deployer-override",
      message: "Override the cbdinocluster deployer? (leave blank for the default)",
    })
  ).trim();
  return deployer === "" ? undefined : deployer;
}

/**
 * Allocate a cluster: write `def` to a file and run
 * `cbdinocluster --verbose allocate [--deployer=<deployer>] --def-file=<file>`.
 * Progress is streamed; resolves with the new cluster's id when allocation
 * succeeds and rejects if it fails (including if no cluster id comes back).
 */
export async function allocateCluster(
  cbdinocluster: string,
  def: string,
  deployer?: string,
): Promise<AllocatedCluster> {
  const { path: defFile, artifact } = writeClusterDef(def);
  console.log(`Wrote cbdinocluster def to ${defFile}:\n\n${def}`);

  const args = ["--verbose", "allocate"];
  if (deployer) {
    args.push(`--deployer=${deployer}`);
  }
  args.push(`--def-file=${defFile}`);

  console.log(`Running: ${cbdinocluster} ${args.join(" ")}\n`);
  const clusterId = parseAllocatedId(await runAndCapture(cbdinocluster, args));
  if (!clusterId) {
    throw new Error("cbdinocluster allocate didn't print a cluster id");
  }
  return { artifacts: [artifact], clusterId };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const cbdinocluster = await ensureCbdinocluster();
    if (!cbdinocluster) {
      process.exit(1);
    }
    const def = buildClusterDef({
      nodeCount: 1,
      version: "8.1.0",
      services: ["kv", "n1ql", "index", "fts"],
      cng: false,
    });
    return allocateCluster(cbdinocluster, def, await askDeployer());
  });
}
