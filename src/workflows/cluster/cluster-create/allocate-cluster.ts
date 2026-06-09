/**
 * Step: allocate a cluster with cbdinocluster from a def document. The def is
 * written to a file in the current run directory under /tmp/fit-cli and then
 * handed to
 * `cbdinocluster --verbose allocate --def-file=<file>` (with an optional
 * --deployer override), whose output is streamed to the console.
 *
 * Run on its own (allocates a default single-node cluster — this really does
 * create a cluster, so only run it if you mean to):
 *   npx tsx src/workflows/cluster/cluster-create/allocate-cluster.ts
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { artifactFromPath, type RunOutput, type Artifact } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { input } from "../../../util/non-fit/prompts.js";
import { formatCommandLine } from "../../../util/non-fit/fit-cli-log.js";
import { capture, run, writeToDebugLog, type RunOptions } from "../../../util/non-fit/proc.js";
import { ensureRunDir } from "../../../util/non-fit/replay.js";
import { posixQuote } from "../../../util/non-fit/remote-target.js";
import { findOnPath } from "../../../util/non-fit/which.js";
import { buildClusterDef } from "./build-cluster-def.js";
import { ensureCbdinocluster } from "./ensure-cbdinocluster.js";
import { parseAllocatedId } from "./parse-allocated-id.js";

/** A cluster cbdinocluster has just allocated. */
export type AllocatedCluster = RunOutput & {
  /** The new cluster's UUID, as passed to `cbdinocluster connstr <id>`. */
  clusterId: string;
};

export interface WriteClusterDefResult {
  path: string;
  artifact: Artifact;
}

export interface ClusterCommandExecutor {
  readonly description: string;
  run(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<void>;
  capture(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<string>;
  runToFile(command: string, args: string[], targetPath: string, cwd?: string): Promise<void>;
  targetFilePath(localPath: string): string;
  stageFile(localPath: string, targetPath?: string): Promise<string>;
  collectFile(targetPath: string, localPath: string): Promise<void>;
  commandAvailable(command: string): Promise<boolean>;
}

export function localClusterCommandExecutor(): ClusterCommandExecutor {
  return {
    description: "this machine",
    run,
    capture,
    runToFile: (command, args, targetPath, cwd) => {
      mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
      return run("sh", ["-lc", `${[command, ...args].map(posixQuote).join(" ")} > ${posixQuote(targetPath)} 2>&1`], cwd, {
        display: formatCommandLine(command, args),
      });
    },
    targetFilePath: (localPath) => localPath,
    stageFile: (localPath) => Promise.resolve(localPath),
    collectFile: (targetPath, localPath) => {
      mkdirSync(dirname(localPath), { recursive: true, mode: 0o700 });
      if (targetPath !== localPath) {
        copyFileSync(targetPath, localPath);
      }
      return Promise.resolve();
    },
    commandAvailable: (command) => Promise.resolve(findOnPath(command) !== undefined),
  };
}

/**
 * Write the cbdinocluster def to a file in the given directory and return its
 * absolute path. Pass a cycle-scoped directory (e.g. `cycleRunDir(cycleIndex)`)
 * for full runs, or omit to use the run root for standalone invocations.
 */
export function writeClusterDef(
  def: string,
  cycleDir: string = ensureRunDir(),
  runDir: string = ensureRunDir(),
): WriteClusterDefResult {
  mkdirSync(cycleDir, { recursive: true, mode: 0o700 });
  const path = join(cycleDir, "cbdinocluster.yaml");
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
  execution: ClusterCommandExecutor = localClusterCommandExecutor(),
  cycleDir: string = ensureRunDir(),
): Promise<AllocatedCluster> {
  const runDir = ensureRunDir();
  const { path: localDefFile, artifact } = writeClusterDef(def, cycleDir, runDir);
  console.log(`Wrote cbdinocluster def to ${localDefFile}:\n\n${def}`);
  const defFile = await execution.stageFile(localDefFile, execution.targetFilePath(localDefFile));

  const args = ["--verbose", "allocate"];
  if (deployer) {
    args.push(`--deployer=${deployer}`);
  }
  args.push(`--def-file=${defFile}`);

  mkdirSync(cycleDir, { recursive: true, mode: 0o700 });
  const localOutputFile = join(cycleDir, "cbdinocluster-allocate.stdout");
  const targetOutputFile = execution.targetFilePath(localOutputFile);
  await execution.runToFile(cbdinocluster, args, targetOutputFile);
  await execution.collectFile(targetOutputFile, localOutputFile);
  const localOutput = readFileSync(localOutputFile, "utf8");
  writeToDebugLog(localOutput);
  const clusterId = parseAllocatedId(localOutput);
  if (!clusterId) {
    throw new Error("cbdinocluster allocate didn't print a cluster id");
  }
  return { artifacts: [artifact], details: [], clusterId };
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
