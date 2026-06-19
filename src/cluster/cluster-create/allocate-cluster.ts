/**
 * Step: allocate a cluster with cbdinocluster from a def document. The def is
 * written to a file in the current run directory under /tmp/fit-cli and then
 * handed to
 * `cbdinocluster --verbose allocate --def-file=<file>` (with an optional
 * --deployer override), whose output is streamed to the console.
 *
 * Run on its own (allocates a default single-node cluster — this really does
 * create a cluster, so only run it if you mean to):
 *   npx tsx src/cluster/cluster-create/allocate-cluster.ts
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { artifactFromPath, type RunOutput, type Artifact } from "../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { input } from "../../util/non-fit/prompts.js";
import { formatCommandLine } from "../../util/non-fit/fit-cli-log.js";
import { capture, run, writeToDebugLog, type RunOptions } from "../../util/non-fit/proc.js";
import { ensureRunDir } from "../../util/non-fit/replay.js";
import { posixQuote } from "../../util/non-fit/remote-target.js";
import { findOnPath } from "../../util/non-fit/which.js";
import { buildClusterDef, DEFAULT_CLUSTER_VERSION } from "./build-cluster-def.js";
import { ensureCbdinocluster } from "./ensure-cbdinocluster.js";
import { parseAllocatedId } from "./parse-allocated-id.js";

/** A cluster cbdinocluster has just allocated. */
export type AllocatedCluster = RunOutput & {
  /** The new cluster's UUID, as passed to `cbdinocluster connstr <id>`. */
  clusterId: string;
  /**
   * For CAO/CNG clusters: the management-UI hostname and CNG-gateway connection
   * string host, fetched via `cbdinocluster mgmt <id>` and
   * `cbdinocluster connstr --couchbase2 <id>` after allocation.
   * Absent for non-CAO deployers.
   */
  caoHosts?: { uiHost: string; cngHost: string };
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
      // Use tee + pipefail so output streams live to the terminal (type 1) AND
      // is saved to the file for artifact collection and cluster-id parsing.
      return run("bash", ["-lc", `set -o pipefail; ${[command, ...args].map(posixQuote).join(" ")} 2>&1 | tee ${posixQuote(targetPath)}`], cwd, {
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
  let runError: unknown;
  try {
    await execution.runToFile(cbdinocluster, args, targetOutputFile);
  } catch (err) {
    runError = err;
  }
  // Always try to collect and log the output, even on failure — cbdinocluster's
  // redirected output is still written to the file before it exits non-zero, and
  // that output is exactly what's needed to diagnose the failure.
  let localOutput = "";
  try {
    await execution.collectFile(targetOutputFile, localOutputFile);
    localOutput = readFileSync(localOutputFile, "utf8");
    writeToDebugLog(localOutput);
  } catch {
    // best-effort: file may not exist if SSH itself never started
  }
  if (runError !== undefined) {
    if (localOutput) {
      process.stderr.write(localOutput.endsWith("\n") ? localOutput : `${localOutput}\n`);
    }
    // Deferred rethrow of the original caught error after collecting output —
    // rethrow it verbatim so its type/stack are preserved.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw runError;
  }
  const clusterId = parseAllocatedId(localOutput);
  if (!clusterId) {
    throw new Error("cbdinocluster allocate didn't print a cluster id");
  }
  let caoHosts: { uiHost: string; cngHost: string } | undefined;
  try {
    const [couchbase2Connstr, mgmtUrl] = await Promise.all([
      execution.capture(cbdinocluster, ["connstr", "--couchbase2", clusterId], undefined, {
        display: "cbdinocluster connstr --couchbase2 (get CNG gateway host)",
      }),
      execution.capture(cbdinocluster, ["mgmt", clusterId], undefined, {
        display: "cbdinocluster mgmt (get management UI host)",
      }),
    ]);
    // "couchbase2://cng-host[:port]" → "cng-host[:port]"
    const cngHost = couchbase2Connstr.trim().replace(/^couchbase2:\/\//, "");
    // "https://ui-host:443" or "http://ip:port" → "ui-host" (strip scheme and port)
    const uiHost = mgmtUrl.trim().replace(/^https?:\/\//, "").replace(/:\d+$/, "");
    if (cngHost && uiHost) {
      caoHosts = { uiHost, cngHost };
    }
  } catch {
    // Non-CAO deployer or commands not supported — caoHosts stays undefined.
  }
  return { artifacts: [artifact], details: [], clusterId, ...(caoHosts ? { caoHosts } : {}) };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const cbdinocluster = await ensureCbdinocluster();
    if (!cbdinocluster) {
      process.exit(1);
    }
    const def = buildClusterDef({
      nodeCount: 1,
      version: DEFAULT_CLUSTER_VERSION,
      services: ["kv", "n1ql", "index", "fts"],
      cng: false,
    });
    return allocateCluster(cbdinocluster, def, await askDeployer());
  });
}
