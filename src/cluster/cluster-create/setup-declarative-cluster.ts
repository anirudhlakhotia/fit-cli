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
 *   bun src/cluster/cluster-create/setup-declarative-cluster.ts
 */
import YAML from "yaml";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type RunOutput } from "../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import type { PieceData } from "../../util/non-fit/config-pieces.js";
import { ensureRunDir } from "../../util/non-fit/replay.js";
import { posixQuote } from "../../util/non-fit/remote-target.js";
import { findOnPath } from "../../util/non-fit/which.js";
import { DEFAULT_CREDENTIALS } from "../cluster-select/ask-credentials.js";
import { classifyConnectionString } from "../cluster-select/classify-connection-string.js";
import type { SelectedCluster } from "../cluster-select/cluster-select.js";
import { parseClusterIds, type CbdinoCluster } from "../cluster-select/parse-cluster-ids.js";
import { parseConnstr } from "../cluster-select/parse-connstr.js";
import {
  allocateCluster,
  localClusterCommandExecutor,
  type ClusterCommandExecutor,
} from "./allocate-cluster.js";
import { CBDINOCLUSTER_URL } from "../../fit/util/config.js";
import { buildCbdinoclusterFromPr, installCbdinoclusterRemote } from "./install-cbdinocluster.js";
import { installCaoCrdsAndAdmission } from "./install-cao-tools.js";
import { enableIngresses } from "./cao-ingress.js";
import { type ClusterExistsPolicy } from "./cluster-exists-policy.js";
import { cngServerImageRef, DEFAULT_CLUSTER_VERSION, type CbdinoclusterDef } from "./build-cluster-def.js";
import { isAlias, resolveAlias } from "./cb-alias.js";
import type { CbdinoclusterInitSetup, CbdinoclusterSource } from "../../fit/shared/definition/types.js";
import { defaultCbdinoclusterInitArgs, situationalCbdinoclusterInitArgs } from "./default-cbdinocluster-init-config.js";

/** The bare command name we look for on the PATH. */
const CBDINOCLUSTER = "cbdinocluster";
const CBDINOCLUSTER_INIT_REQUIRED = "you must run the `init` command first";
const CBDINOCLUSTER_CONFIG_FILENAME = ".cbdinocluster";
const CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH = `~/${CBDINOCLUSTER_CONFIG_FILENAME}`;

async function resolveCbdinoclusterCommand(
  execution: ClusterCommandExecutor,
  source?: CbdinoclusterSource,
): Promise<string | undefined> {
  // When a PR source is specified, always build from that PR on the remote box —
  // even if some other cbdinocluster binary happens to be on PATH already.
  if (source?.git !== undefined) {
    if (execution.description === "this machine") {
      console.error(
        `\n✗ setup-cluster: cbdinocluster.source.git is only supported on remote (AWS) instances, not on this machine.`,
      );
      return undefined;
    }
    return buildCbdinoclusterFromPr(execution, source.git);
  }

  if (await execution.commandAvailable(CBDINOCLUSTER)) {
    return CBDINOCLUSTER;
  }

  // On this machine we don't auto-install — the caller points the operator at
  // where to get it. On a remote box we install the matching binary straight
  // from the cbdinocluster releases instead of staging up whatever (if anything)
  // is on this machine.
  if (execution.description === "this machine") {
    return findOnPath(CBDINOCLUSTER) ?? undefined;
  }

  console.log(`→ setup-cluster: cbdinocluster isn't on ${execution.description} — installing the latest release.`);
  return installCbdinoclusterRemote(execution);
}

export function cbdinoclusterNeedsInit(message: string): boolean {
  return message.includes(CBDINOCLUSTER_INIT_REQUIRED);
}

/** Whether the executor runs on a remote box (vs. this machine). */
function isRemoteExecution(execution: ClusterCommandExecutor): boolean {
  return "kind" in execution && (execution as { kind?: string }).kind === "remote";
}

function dockerNetworkFromInitConfig(config: PieceData): string | undefined {
  const docker = config.docker;
  if (!docker || typeof docker !== "object" || Array.isArray(docker) || docker === null) {
    return undefined;
  }
  return typeof docker.network === "string" && docker.network.trim() ? docker.network.trim() : undefined;
}

async function uploadCbdinoclusterConfig(execution: ClusterCommandExecutor, config: PieceData, cycleDir: string): Promise<void> {
  mkdirSync(cycleDir, { recursive: true, mode: 0o700 });
  const localConfigPath = join(cycleDir, "cbdinocluster-init.yaml");
  writeFileSync(localConfigPath, YAML.stringify(config));
  const stagedConfigPath = await execution.stageFile(localConfigPath, execution.targetFilePath(localConfigPath));
  await execution.run("sh", [
    "-lc",
    `cp ${posixQuote(stagedConfigPath)} ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH} && chmod 600 ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH}`,
  ], undefined, { display: `install cbdinocluster config to ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH}` });
}

async function ensureDockerNetwork(execution: ClusterCommandExecutor, network: string): Promise<void> {
  if (["bridge", "host", "none"].includes(network)) {
    return;
  }
  // Probe silently (we only need the exit code), then create only if absent so
  // the creation output flows through run() and into session.debug.log.
  const exists = await execution.capture("sh", [
    "-lc",
    `docker network inspect ${posixQuote(network)} >/dev/null 2>&1 && printf yes || printf no`,
  ], undefined, { quiet: true }).then((out) => out.trim() === "yes").catch(() => false);
  if (!exists) {
    await execution.run("docker", ["network", "create", network], undefined, {
      display: `docker network create ${network}`,
    });
  }
}

/** Parse `--docker-network <name>` (or `--docker-network=<name>`) out of an init args string. */
export function dockerNetworkFromInitArgs(args: string): string | undefined {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--docker-network" && tokens[i + 1]) {
      return tokens[i + 1];
    }
    const inline = tokens[i].match(/^--docker-network=(.+)$/);
    if (inline) {
      return inline[1];
    }
  }
  return undefined;
}

/**
 * Prepare `~/.cbdinocluster` on a clean box by running `cbdinocluster init <args>`,
 * letting cbdinocluster self-install its config (the docker path). `args` is the
 * editable string from the definition; the GitHub credentials are appended here so
 * they never live in the definition file — with creds we pass
 * `--github-user/--github-token` (which enables GitHub), without them
 * `--disable-github`. Afterwards the docker network the args name is created if it
 * isn't a built-in (cbdinocluster init records the network but doesn't create it).
 *
 * Only runs on a remote box; on this machine we leave the operator's own
 * `~/.cbdinocluster` (and its clusters) alone, mirroring
 * {@link prepareCbdinoclusterConfig}.
 */
export async function runCbdinoclusterInit(
  execution: ClusterCommandExecutor,
  cbdinocluster: string,
  args: string,
  githubCredentials?: { user: string; token: string },
  configPatch?: PieceData,
  cycleDir: string = ensureRunDir(),
): Promise<void> {
  if (!("kind" in execution) || execution.kind !== "remote") {
    return;
  }
  const initArgs = args.trim().split(/\s+/).filter(Boolean);
  const credArgs = githubCredentials
    ? ["--github-user", githubCredentials.user, "--github-token", githubCredentials.token]
    : ["--disable-github"];
  console.log(
    `→ setup-cluster: initializing cbdinocluster on ${execution.description} with \`cbdinocluster init ${args}\``,
  );
  // Start from a clean slate: an instance with several execution groups runs init
  // once per group against the same `~/.cbdinocluster`. `init --auto` takes its
  // "enable Capella?" default from any existing config, so a docker-only group's
  // init (`--disable-capella`) would otherwise poison a later situational group's
  // init into leaving Capella disabled — no `cloud` deployer, and `allocate
  // --deployer cloud` later fatals with "no deployers". Removing the file first
  // makes `--auto` key off the forwarded env/flags, not the previous group's run.
  // Only the config (deployers/creds) is removed; cluster state lives in Docker.
  await execution.run("sh", ["-lc", `rm -f ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH}`], undefined, {
    display: `rm -f ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH}`,
  });
  // Run via a login shell so `~/.profile` is sourced and `init --auto` inherits the
  // forwarded CAPELLA_*/AWS_* env vars (without them it silently leaves the capella
  // block disabled and `cbdinocluster allocate --deployer cloud` later fatals with
  // "no deployers"). `execution.run` would otherwise ssh in non-login. The
  // credentials are kept out of the echoed command via `display`.
  const initCmdline = [cbdinocluster, "init", ...initArgs, ...credArgs].map(posixQuote).join(" ");
  await execution.run("bash", ["-lc", initCmdline], undefined, {
    display: `cbdinocluster init ${args}`,
  });
  const network = dockerNetworkFromInitArgs(args);
  if (network) {
    console.log(`→ setup-cluster: ensuring Docker network ${network} exists on ${execution.description}`);
    await ensureDockerNetwork(execution, network);
  }
  // Layer on config `cbdinocluster init` can't set via flags (e.g. situational's
  // capella/aws blocks — `--auto` leaves those disabled regardless of flags).
  if (configPatch) {
    await mergeRemoteCbdinoclusterConfig(execution, configPatch, cycleDir);
  }
}

/**
 * Merge extra top-level blocks onto the `~/.cbdinocluster` that `cbdinocluster
 * init` just wrote, for config init can't express via flags (situational's
 * `capella`/`aws`). Reads the file init produced, shallow-merges the patch's
 * top-level keys over it, and writes it back. Remote-only, mirroring
 * {@link runCbdinoclusterInit}: on this machine we leave the operator's own
 * `~/.cbdinocluster` alone.
 */
export async function mergeRemoteCbdinoclusterConfig(
  execution: ClusterCommandExecutor,
  patch: PieceData,
  cycleDir: string = ensureRunDir(),
): Promise<void> {
  if (!("kind" in execution) || execution.kind !== "remote") {
    return;
  }
  const existing = await execution.capture(
    "sh",
    ["-lc", `cat ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH}`],
    undefined,
    { quiet: true },
  );
  const base = (YAML.parse(existing) ?? {}) as PieceData;
  const merged: PieceData = { ...base, ...patch };
  console.log(
    `→ setup-cluster: merging capella/aws config into ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH} on ${execution.description}`,
  );
  await uploadCbdinoclusterConfig(execution, merged, cycleDir);
}

/**
 * Verify `cbdinocluster init` actually enabled the Capella (cloud) deployer, by
 * confirming the forwarded control-plane `endpoint` made it into the written
 * `~/.cbdinocluster`. Situational runs need the cloud deployer; without it every
 * test later fatals at `allocate --deployer cloud` with "no deployers", so a
 * fail-fast check here surfaces the real cause. Schema-agnostic on purpose — we
 * look for the endpoint string rather than cbdinocluster's internal YAML keys.
 * Remote-only, and skipped when there's no endpoint to look for (returns true).
 */
export async function remoteCbdinoclusterCloudEnabled(
  execution: ClusterCommandExecutor,
  capellaEndpoint: string | undefined,
): Promise<boolean> {
  if (!("kind" in execution) || execution.kind !== "remote" || !capellaEndpoint) {
    return true;
  }
  const config = await execution.capture(
    "sh",
    ["-lc", `cat ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH}`],
    undefined,
    { quiet: true },
  );
  return config.includes(capellaEndpoint);
}

/**
 * Prepare `~/.cbdinocluster` from a definition's init setup, picking the right
 * path: the `args` path runs `cbdinocluster init <args>` (and merges any
 * `configPatch`); the legacy `config` path uploads a config object verbatim (CNG).
 * Used by the situational flow, which sets up its own cluster outside
 * {@link setupDeclarativeCluster}.
 */
export async function prepareCbdinoclusterInit(
  execution: ClusterCommandExecutor,
  init: CbdinoclusterInitSetup | undefined,
  githubCredentials?: { user: string; token: string },
  cycleDir: string = ensureRunDir(),
  source?: CbdinoclusterSource,
): Promise<void> {
  if (init?.config !== undefined) {
    await prepareCbdinoclusterConfig(execution, init.config, githubCredentials, cycleDir);
  } else if (init !== undefined) {
    // Situational path: run cbdinocluster init with explicit args if present, or
    // generate the standard situational defaults.
    const args = init.args ?? situationalCbdinoclusterInitArgs();
    const cbdinocluster = await resolveCbdinoclusterCommand(execution, source);
    if (!cbdinocluster) {
      console.error(
        `\n✗ setup-cluster: cbdinocluster isn't on the PATH for ${execution.description}. ` +
          `Get it from ${CBDINOCLUSTER_URL}.`,
      );
      return;
    }
    await runCbdinoclusterInit(execution, cbdinocluster, args, githubCredentials, init.configPatch, cycleDir);
  }
}

export async function prepareCbdinoclusterConfig(
  execution: ClusterCommandExecutor,
  config: PieceData | undefined,
  githubCredentials?: { user: string; token: string },
  cycleDir: string = ensureRunDir(),
): Promise<void> {
  if (!config || !("kind" in execution) || execution.kind !== "remote") {
    return;
  }
  const configToUpload: PieceData = githubCredentials
    ? { ...config, github: { enabled: "true", user: githubCredentials.user, token: githubCredentials.token } }
    : config;
  console.log(
    `→ setup-cluster: uploading cbdinocluster config to ${execution.description} as ${CBDINOCLUSTER_DEFAULT_REMOTE_CONFIG_PATH}`,
  );
  await uploadCbdinoclusterConfig(execution, configToUpload, cycleDir);
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

/**
 * Pull a cluster id's connection string out of cbdinocluster. For CNG we ask for
 * the performer's couchbase2 string with `--couchbase2`; otherwise we take the
 * classic one. Returns null (after explaining) if there isn't a usable string.
 */
async function connstrFor(
  cbdinocluster: string,
  id: string,
  execution: ClusterCommandExecutor,
  couchbase2: boolean,
): Promise<string | null> {
  const args = couchbase2 ? ["connstr", "--couchbase2", id] : ["connstr", id];
  let connectionString: string | null;
  try {
    connectionString = parseConnstr(await execution.capture(cbdinocluster, args));
  } catch (err) {
    console.error(`✗ setup-cluster: couldn't get the connection string for ${id}: ${(err as Error).message}`);
    return null;
  }
  if (!connectionString) {
    console.error(`✗ setup-cluster: cbdinocluster didn't return a connection string for ${id}.`);
    return null;
  }
  return connectionString;
}

/**
 * Resolve a cluster id's connection string into a {@link SelectedCluster}. For a
 * CNG cluster the classic string drives the test-driver (admin) while a second
 * `--couchbase2` string drives the performer, so both are fetched and combined.
 *
 * For CAO/OpenShift CNG clusters `cbdinocluster connstr` does not return
 * endpoints; we use the `caoHosts` parsed from the allocate output instead.
 */
async function selectedClusterFor(
  cbdinocluster: string,
  id: string,
  execution: ClusterCommandExecutor,
  cng = false,
  caoHosts?: { uiHost: string; cngHost: string },
): Promise<SelectedCluster | undefined> {
  // CAO/OpenShift clusters: build connstrs from the parsed route hostnames
  // instead of calling `cbdinocluster connstr` (which returns "no endpoint available").
  if (cng && caoHosts) {
    // OpenShift TLS-passthrough routes expose external port 443 (not the native Couchbase
    // management port 18091).  Include :443 so the SDK bootstraps on the correct port.
    const managementConnstr = `couchbases://${caoHosts.uiHost}:443`;
    // cngHost comes from `cbdinocluster connstr --couchbase2` with port already included.
    const performerConnectionString = `couchbase2://${caoHosts.cngHost}`;
    console.log(`→ setup-cluster: CNG cluster ${id} management at ${managementConnstr}`);
    console.log(`→ setup-cluster: CNG performer connects over ${performerConnectionString}`);
    const cluster = buildSelectedClusterFromConnstr(managementConnstr);
    if (!cluster) {
      return undefined;
    }
    return { ...cluster, cng: { performerConnectionString, tls: { insecure: true } } };
  }

  const connectionString = await connstrFor(cbdinocluster, id, execution, false);
  if (!connectionString) {
    return undefined;
  }
  console.log(`→ setup-cluster: cluster ${id} is at ${connectionString}`);
  const cluster = buildSelectedClusterFromConnstr(connectionString);
  if (!cluster || !cng) {
    return cluster;
  }

  const performerConnectionString = await connstrFor(cbdinocluster, id, execution, true);
  if (!performerConnectionString) {
    console.error(`✗ setup-cluster: CNG cluster ${id} has no couchbase2 connection string for the performer.`);
    return undefined;
  }
  console.log(`→ setup-cluster: CNG performer connects over ${performerConnectionString}`);
  return {
    ...cluster,
    cng: { performerConnectionString, tls: { insecure: true } },
  };
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
  console.log(`\nRemoving cluster ${id}...`);
  try {
    await execution.run(cbdinocluster, removeClusterArgs(id));
    console.log(`\n✓ Removed cluster ${id}`);
    return true;
  } catch (err) {
    console.error(`\n✗ Failed to remove cluster ${id}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Create the default bucket on a CAO/OpenShift CNG cluster via the management REST API.
 *
 * CAO clusters use `buckets.managed: false` so no bucket is auto-created, and there is no
 * external KV port for the test-driver's classic SDK to use.  Retries for up to 120 s to
 * survive the "Cannot create bucket during rebalance" window after the cluster first comes up.
 */
async function createCaoDefaultBucket(
  uiHost: string,
  username: string,
  password: string,
  execution: ClusterCommandExecutor,
): Promise<void> {
  const bucketUrl = `https://${uiHost}:443/pools/default/buckets`;
  console.log(`→ setup-cluster: creating default bucket via ${bucketUrl}`);
  const createScript = [
    "set -e",
    "deadline=$(($(date +%s) + 120))",
    "while true; do",
    "  tmpout=$(mktemp)",
    // ramQuota=100 matches the GHA workflow — small enough to leave headroom for test buckets.
    `  status=$(curl --silent --show-error --insecure -w '%{http_code}' -o "$tmpout" -X POST '${bucketUrl}' -u '${username}:${password}' -d name=default -d bucketType=couchbase -d ramQuota=100 2>&1 || echo 000)`,
    "  body=$(cat \"$tmpout\"); rm -f \"$tmpout\"",
    '  if [ "$status" = "202" ]; then echo "  ✓ Default bucket created (HTTP $status)"; exit 0; fi',
    '  if [ "$status" = "400" ] && echo "$body" | grep -q "already exists"; then echo "  ✓ Default bucket already exists"; exit 0; fi',
    '  if [ $(date +%s) -ge $deadline ]; then echo "  ✗ Timed out creating default bucket (HTTP $status): $body" >&2; exit 1; fi',
    '  echo "  Management API not ready yet (HTTP $status, fit-cli is waiting not hung): $body"',
    "  sleep 5",
    "done",
  ].join("\n");
  try {
    await execution.run("sh", ["-lc", createScript], undefined, { display: "create default bucket" });
  } catch (err) {
    console.error(`  ✗ Failed to create default bucket: ${(err as Error).message}`);
  }
}

/** Allocate a fresh cluster from the resolved plan and resolve it for the run. */
async function allocate(
  cbdinocluster: string,
  config: CbdinoclusterDef,
  deployer: string | undefined,
  execution: ClusterCommandExecutor,
  cycleDir: string,
  cng: boolean,
): Promise<SetupDeclarativeClusterResult> {
  const resolvedConfig = {
    ...config,
    nodes: await Promise.all(
      config.nodes.map(async (node) => ({
        ...node,
        version: isAlias(node.version) ? await resolveAlias(node.version) : node.version,
      })),
    ),
  };

  let allocated;
  try {
    allocated = await allocateCluster(cbdinocluster, YAML.stringify(resolvedConfig), deployer, execution, cycleDir);
    console.log("\n✓ setup-cluster: cbdinocluster allocated the cluster");
  } catch (err) {
    console.error(`\n✗ setup-cluster: cbdinocluster failed to allocate the cluster: ${(err as Error).message}`);
    return FAILED({ cbdinocluster });
  }

  // cao (CNG) clusters need their ingresses enabled before the data/REST planes —
  // and so the performer's couchbase2 connection string — become reachable.
  if (cng) {
    await enableIngresses(cbdinocluster, allocated.clusterId, execution);
  }

  const cluster = await selectedClusterFor(cbdinocluster, allocated.clusterId, execution, cng, allocated.caoHosts);

  if (cng && allocated.caoHosts) {
    const { username, password } = cluster?.credentials ?? { username: "Administrator", password: "password" };
    await createCaoDefaultBucket(allocated.caoHosts.uiHost, username, password, execution);
  }

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
  init?: CbdinoclusterInitSetup;
  config: CbdinoclusterDef;
  onClusterExists: ClusterExistsPolicy;
  deployer?: string;
  /** CNG cluster: also fetch the couchbase2 connstr so the performer can connect. */
  cng?: boolean;
  /**
   * True when the Kubernetes cluster is shared (e.g. OpenShift/ROSA): CRDs and the
   * admission controller are already installed cluster-wide, so we must not delete and
   * reinstall them — doing so would break other users' clusters running in other namespaces.
   */
  cngSharedCluster?: boolean;
  /** GitHub credentials to inject into the uploaded ~/.cbdinocluster (for GHCR image pulls). */
  githubCredentials?: { user: string; token: string };
  /** Where to get the cbdinocluster binary. Absent means latest release. */
  source?: CbdinoclusterSource;
}, execution: ClusterCommandExecutor = localClusterCommandExecutor(), cycleDir: string = ensureRunDir()): Promise<SetupDeclarativeClusterResult> {
  const cng = plan.cng ?? false;
  const cbdinocluster = await resolveCbdinoclusterCommand(execution, plan.source);
  if (!cbdinocluster) {
    console.error(
      `\n✗ setup-cluster: cbdinocluster isn't on the PATH for ${execution.description}. ` +
        `Get it from ${CBDINOCLUSTER_URL}.`,
    );
    return FAILED();
  }

  // CNG uploads a config object verbatim. For the docker path, run cbdinocluster init
  // with explicit args from the definition if present, or generate the standard
  // functional defaults. An empty init block ({}) means "run default init".
  if (plan.init?.config !== undefined) {
    await prepareCbdinoclusterConfig(execution, plan.init.config, plan.githubCredentials, cycleDir);
  } else if (plan.init !== undefined) {
    const args = plan.init.args ?? defaultCbdinoclusterInitArgs();
    await runCbdinoclusterInit(execution, cbdinocluster, args, plan.githubCredentials, plan.init.configPatch, cycleDir);
  }

  // CNG on a clean k3d box: install the Couchbase CRDs + admission controller the cao
  // deployer needs — the steps cbdinocluster's interactive `init` would prompt for
  // and which the non-interactive allocate would otherwise fail on. On localhost
  // we leave the operator's own ~/.cbdinocluster (and its cluster) alone.
  // On a shared cluster (OpenShift/ROSA) the CRDs are already installed cluster-wide;
  // deleting and reinstalling them would break other users' clusters in other namespaces.
  if (cng && isRemoteExecution(execution) && !plan.cngSharedCluster) {
    await installCaoCrdsAndAdmission(execution, cbdinocluster);
  }

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
    const cluster = await selectedClusterFor(cbdinocluster, decision.cluster.id, execution, cng);
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

  // Pull the server image before handing off to cbdinocluster — image pull failures are
  // a common cause of long, opaque cbdinocluster timeouts, so surfacing them early helps.
  if (cng && isRemoteExecution(execution)) {
    const serverVersion = plan.config.nodes[0]?.version;
    if (serverVersion) {
      const imageRef = cngServerImageRef(serverVersion);
      console.log(`→ setup-cluster: pre-flight docker pull ${imageRef} (non-fatal)…`);
      try {
        await execution.run("docker", ["pull", imageRef]);
      } catch {
        console.warn(`→ setup-cluster: docker pull ${imageRef} failed (non-fatal — cbdinocluster will try again)`);
      }
    }
  }

  return allocate(cbdinocluster, plan.config, plan.deployer ?? (cng ? "cao" : "docker"), execution, cycleDir, cng);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const result = await setupDeclarativeCluster({
      config: { nodes: [{ count: 1, version: DEFAULT_CLUSTER_VERSION, services: ["kv", "n1ql", "index"] }] },
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
