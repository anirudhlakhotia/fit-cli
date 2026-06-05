/**
 * Step: stand up the cluster a definition file asked for with its `cbdinocluster`
 * block — the non-interactive, definition-driven counterpart to the guided
 * cluster-create workflow. It's what the run-from-definition flow's setup-cluster
 * step calls.
 *
 * The shape mirrors the performer's "check and run" logic: look at what's already
 * there, apply the file's {@link ClusterExistsPolicy} (rather than prompting),
 * then allocate as needed and resolve the result into a {@link SelectedCluster}
 * the rest of the run can test against. Like the performer, it does *not* check
 * that an existing cluster matches the desired spec — `useExisting` trusts it.
 *
 * Run on its own (this can really allocate/remove clusters, so mean it):
 *   npx tsx src/workflows/cluster/cluster-create/setup-declarative-cluster.ts
 */
import YAML from "yaml";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import type { PieceData } from "../../../util/non-fit/config-pieces.js";
import { ensureRunDir } from "../../../util/non-fit/replay.js";
import { posixQuote } from "../../../util/non-fit/remote-target.js";
import { findOnPath } from "../../../util/non-fit/which.js";
import { DEFAULT_CREDENTIALS } from "../cluster-select/ask-credentials.js";
import { classifyConnectionString } from "../cluster-select/classify-connection-string.js";
import type { SelectedCluster } from "../cluster-select/index.js";
import { parseClusterIds, type CbdinoCluster } from "../cluster-select/parse-cluster-ids.js";
import { parseConnstr } from "../cluster-select/parse-connstr.js";
import {
  allocateCluster,
  localClusterCommandExecutor,
  type ClusterCommandExecutor,
} from "./allocate-cluster.js";
import { CBDINOCLUSTER_URL } from "./ensure-cbdinocluster.js";
import { type ClusterExistsPolicy } from "./cluster-exists-policy.js";
import { type CbdinoclusterDef } from "./build-cluster-def.js";

/** The bare command name we look for on the PATH. */
const CBDINOCLUSTER = "cbdinocluster";
const CBDINOCLUSTER_INIT_REQUIRED = "you must run the `init` command first";
const CBDINOCLUSTER_CONFIG_FILENAME = ".cbdinocluster";
const CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH = `~/${CBDINOCLUSTER_CONFIG_FILENAME}`;

async function resolveCbdinoclusterCommand(execution: ClusterCommandExecutor): Promise<string | undefined> {
  if (await execution.commandAvailable(CBDINOCLUSTER)) {
    return CBDINOCLUSTER;
  }

  const localBinary = findOnPath(CBDINOCLUSTER);
  if (!localBinary) {
    return undefined;
  }

  if (execution.description === "this machine") {
    return localBinary;
  }

  const remoteBinary = execution.targetFilePath(localBinary);
  console.log(`→ setup-cluster: staging local cbdinocluster to ${execution.description} at ${remoteBinary}`);
  await execution.stageFile(localBinary, remoteBinary);
  await execution.run("chmod", ["755", remoteBinary]);
  return remoteBinary;
}

export function cbdinoclusterNeedsInit(message: string): boolean {
  return message.includes(CBDINOCLUSTER_INIT_REQUIRED);
}

function dockerNetworkFromInitConfig(config: PieceData): string | undefined {
  const docker = config.docker;
  if (!docker || typeof docker !== "object" || Array.isArray(docker) || docker === null) {
    return undefined;
  }
  return typeof docker.network === "string" && docker.network.trim() ? docker.network.trim() : undefined;
}

async function uploadCbdinoclusterConfig(execution: ClusterCommandExecutor, config: PieceData): Promise<void> {
  const runDir = ensureRunDir();
  const localConfigPath = join(runDir, "cbdinocluster-init.yaml");
  writeFileSync(localConfigPath, YAML.stringify(config));
  const stagedConfigPath = await execution.stageFile(localConfigPath, execution.targetFilePath(localConfigPath));
  await execution.run("sh", [
    "-lc",
    `cp ${posixQuote(stagedConfigPath)} ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH} && chmod 600 ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH}`,
  ]);
}

async function ensureDockerNetwork(execution: ClusterCommandExecutor, network: string): Promise<void> {
  if (["bridge", "host", "none"].includes(network)) {
    return;
  }
  await execution.run("sh", [
    "-lc",
    `docker network inspect ${posixQuote(network)} >/dev/null 2>&1 || docker network create ${posixQuote(network)} >/dev/null`,
  ]);
}

async function prepareCbdinoclusterConfig(execution: ClusterCommandExecutor, config: PieceData | undefined): Promise<void> {
  if (!config || !("kind" in execution) || execution.kind !== "remote") {
    return;
  }
  console.log(
    `→ setup-cluster: uploading cbdinocluster config to ${execution.description} as ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH}`,
  );
  await uploadCbdinoclusterConfig(execution, config);
  const network = dockerNetworkFromInitConfig(config);
  if (network) {
    console.log(`→ setup-cluster: ensuring Docker network ${network} exists on ${execution.description}`);
    await ensureDockerNetwork(execution, network);
  }
}

async function listExistingClusters(
  cbdinocluster: string,
  execution: ClusterCommandExecutor,
): Promise<CbdinoCluster[] | undefined> {
  try {
    return parseClusterIds(await execution.capture(cbdinocluster, ["ps"]));
  } catch (err) {
    const message = (err as Error).message;
    if (!cbdinoclusterNeedsInit(message)) {
      console.error(`\n✗ setup-cluster: couldn't list clusters (cbdinocluster ps): ${message}`);
      return undefined;
    }

    console.log(
      `→ setup-cluster: ${execution.description} has no cbdinocluster config yet — ` +
        `initializing a default one with \`${cbdinocluster} init --auto\`.`,
    );
    try {
      await execution.run(cbdinocluster, ["init", "--auto"]);
    } catch (initErr) {
      console.error(`\n✗ setup-cluster: couldn't initialize cbdinocluster: ${(initErr as Error).message}`);
      return undefined;
    }

    try {
      return parseClusterIds(await execution.capture(cbdinocluster, ["ps"]));
    } catch (retryErr) {
      console.error(
        `\n✗ setup-cluster: couldn't list clusters (cbdinocluster ps) after init: ${(retryErr as Error).message}`,
      );
      return undefined;
    }
  }
}

/** What setup-declarative-cluster decided to do about existing clusters (pure). */
export type ClusterExistsDecision =
  /** Nothing relevant is running (or none to reuse) — allocate a fresh cluster. */
  | { action: "allocate" }
  /** Trust the cluster already running and test against it. */
  | { action: "useExisting"; cluster: CbdinoCluster }
  /** Remove these clusters, then allocate a fresh one. */
  | { action: "recreate"; remove: CbdinoCluster[] }
  /** Stop the run without touching anything. */
  | { action: "abort"; reason: string };

/**
 * Decide what to do given the clusters cbdinocluster currently has running and
 * the file's policy. Pure logic — no IO — so it's easy to unit test. With no
 * existing clusters every policy allocates; `useExisting` trusts the first one.
 */
export function decideClusterExists(
  existing: CbdinoCluster[],
  policy: ClusterExistsPolicy,
): ClusterExistsDecision {
  if (existing.length === 0) {
    return { action: "allocate" };
  }
  switch (policy) {
    case "fail":
      return {
        action: "abort",
        reason:
          `${existing.length} cbdinocluster cluster(s) already running and onClusterExists is "fail". ` +
          `Remove them (cbdinocluster rm <id>) or change onClusterExists.`,
      };
    case "useExisting":
      return { action: "useExisting", cluster: existing[0] };
    case "destroyAndRecreate":
      return { action: "recreate", remove: existing };
  }
}

/** The outcome of standing up (or reusing) the cluster for a definition run. */
export interface SetupDeclarativeClusterResult extends RunOutput {
  /** The cluster to test against; undefined if setup failed. */
  cluster?: SelectedCluster;
  /** Whether this run allocated the cluster (and so should tear it down). */
  allocated: boolean;
  /** The allocated cluster's id, present when {@link allocated} is true. */
  clusterId?: string;
  /** The resolved cbdinocluster command, present when one was found — for teardown. */
  cbdinocluster?: string;
}

const FAILED = (extra: Partial<SetupDeclarativeClusterResult> = {}): SetupDeclarativeClusterResult => ({
  allocated: false,
  artifacts: [],
  details: [],
  ...extra,
});

/**
 * Turn a cbdinocluster connection string into a {@link SelectedCluster}, using
 * the default self-managed credentials (what a freshly allocated cluster uses).
 * Returns undefined and explains if the connection string isn't one we can use.
 */
export function buildSelectedClusterFromConnstr(connectionString: string): SelectedCluster | undefined {
  const classification = classifyConnectionString(connectionString);
  if (classification.kind !== "supported") {
    console.error(
      `✗ setup-cluster: cbdinocluster returned ${connectionString}, which fit-cli can't use ` +
        `(${classification.kind}).`,
    );
    return undefined;
  }
  return {
    scheme: classification.scheme,
    defaultHostname: classification.defaultHostname,
    flavour: classification.flavour,
    credentials: { ...DEFAULT_CREDENTIALS },
    // A cbdino couchbases:// cluster uses a self-signed cert; trust it insecurely.
    tls: classification.scheme === "couchbases" ? { insecure: true } : null,
  };
}

/** Resolve a cluster id's connection string into a {@link SelectedCluster}. */
async function selectedClusterFor(
  cbdinocluster: string,
  id: string,
  execution: ClusterCommandExecutor,
): Promise<SelectedCluster | undefined> {
  let connectionString: string | null;
  try {
    connectionString = parseConnstr(await execution.capture(cbdinocluster, ["connstr", id]));
  } catch (err) {
    console.error(`✗ setup-cluster: couldn't get the connection string for ${id}: ${(err as Error).message}`);
    return undefined;
  }
  if (!connectionString) {
    console.error(`✗ setup-cluster: cbdinocluster didn't return a connection string for ${id}.`);
    return undefined;
  }
  console.log(`→ setup-cluster: cluster ${id} is at ${connectionString}`);
  return buildSelectedClusterFromConnstr(connectionString);
}

/** Build the `cbdinocluster rm <id>` args. */
export function removeClusterArgs(id: string): string[] {
  return ["remove", id];
}

/** Remove a cbdinocluster cluster, streaming progress. Resolves whether it worked. */
export async function removeCluster(
  cbdinocluster: string,
  id: string,
  execution: ClusterCommandExecutor,
): Promise<boolean> {
  console.log(`\nRemoving cluster ${id} with:\n  cbdinocluster ${removeClusterArgs(id).join(" ")}\n`);
  try {
    await execution.run(cbdinocluster, removeClusterArgs(id));
    console.log(`\n✓ Removed cluster ${id}`);
    return true;
  } catch (err) {
    console.error(`\n✗ Failed to remove cluster ${id}: ${(err as Error).message}`);
    return false;
  }
}

/** Allocate a fresh cluster from the resolved plan and resolve it for the run. */
async function allocate(
  cbdinocluster: string,
  config: CbdinoclusterDef,
  deployer: string | undefined,
  execution: ClusterCommandExecutor,
): Promise<SetupDeclarativeClusterResult> {
  let allocated;
  try {
    allocated = await allocateCluster(cbdinocluster, YAML.stringify(config), deployer, execution);
    console.log("\n✓ setup-cluster: cbdinocluster allocated the cluster");
  } catch (err) {
    console.error(`\n✗ setup-cluster: cbdinocluster failed to allocate the cluster: ${(err as Error).message}`);
    return FAILED({ cbdinocluster });
  }

  const cluster = await selectedClusterFor(cbdinocluster, allocated.clusterId, execution);
  return {
    ...(cluster ? { cluster } : {}),
    allocated: true,
    clusterId: allocated.clusterId,
    cbdinocluster,
    artifacts: allocated.artifacts,
    details: allocated.details,
  };
}

/**
 * Stand up (or reuse) the cluster described by a resolved cbdinocluster plan.
 * Finds cbdinocluster on the PATH, lists what's already running, applies the
 * policy, and allocates as needed. Failures are explained and surfaced as a
 * result with `cluster: undefined` rather than thrown.
 */
export async function setupDeclarativeCluster(plan: {
  init?: { config: PieceData };
  config: CbdinoclusterDef;
  onClusterExists: ClusterExistsPolicy;
  deployer?: string;
}, execution: ClusterCommandExecutor = localClusterCommandExecutor()): Promise<SetupDeclarativeClusterResult> {
  const cbdinocluster = await resolveCbdinoclusterCommand(execution);
  if (!cbdinocluster) {
    console.error(
      `\n✗ setup-cluster: cbdinocluster isn't on the PATH for ${execution.description}. ` +
        `Get it from ${CBDINOCLUSTER_URL}.`,
    );
    return FAILED();
  }

  await prepareCbdinoclusterConfig(execution, plan.init?.config);

  // `cbdinocluster ps` doubles as a sanity check and the list of what's running.
  const existing = await listExistingClusters(cbdinocluster, execution);
  if (!existing) {
    return FAILED({ cbdinocluster });
  }

  const decision = decideClusterExists(existing, plan.onClusterExists);

  if (decision.action === "abort") {
    console.error(`\n✗ setup-cluster: ${decision.reason}`);
    return FAILED({ cbdinocluster });
  }

  if (decision.action === "useExisting") {
    console.log(
      `→ setup-cluster: onClusterExists is "useExisting" — trusting the running cluster ` +
        `${decision.cluster.id} [${decision.cluster.details}].`,
    );
    const cluster = await selectedClusterFor(cbdinocluster, decision.cluster.id, execution);
    return { ...(cluster ? { cluster } : {}), allocated: false, cbdinocluster, artifacts: [], details: [] };
  }

  if (decision.action === "recreate") {
    console.log(
      `→ setup-cluster: onClusterExists is "destroyAndRecreate" — removing ` +
        `${decision.remove.length} existing cluster(s) before allocating.`,
    );
    for (const cluster of decision.remove) {
      await removeCluster(cbdinocluster, cluster.id, execution);
    }
  }

  return allocate(cbdinocluster, plan.config, plan.deployer, execution);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const result = await setupDeclarativeCluster({
      config: { nodes: [{ count: 1, version: "8.1.0", services: ["kv", "n1ql", "index"] }] },
      onClusterExists: "destroyAndRecreate",
    });
    console.log(JSON.stringify({ ...result, artifacts: result.artifacts.length }, null, 2));
    if (result.allocated && result.clusterId && result.cbdinocluster) {
      console.log("\n(standalone run) removing the cluster it just allocated…");
      await removeCluster(result.cbdinocluster, result.clusterId, localClusterCommandExecutor());
    }
    process.exit(result.cluster ? 0 : 1);
  });
}
