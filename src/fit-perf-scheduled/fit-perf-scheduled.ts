/**
 * fit-perf-scheduled — run FIT/PERF (SDK performance testing) on a clean, throwaway
 * EC2 instance, standing in for what fit-as-a-service's scheduled Prefect flow does:
 * launch a box, allocate a Couchbase cluster with cbdinocluster, build and run the
 * jenkins-sdk driver against a config, and report results into the same production
 * results database FIT/SIT uses.
 *
 * This is deliberately NOT a `fit` subcommand and does NOT use a FIT definition file —
 * it's a standalone script (reusing fit-cli's EC2/SSH/secrets library code) meant to be
 * run directly from CI (see .github/workflows/fit-perf-scheduled.yaml) or localhost.
 * See working/fit-perf.md for why (option 1: a thin script, not a rework of fit-cli's
 * definition-file model).
 *
 * Run on its own (this really launches an EC2 instance and, on success, writes
 * results to the production perf database — only run it if you mean to):
 *   bun src/fit-perf-scheduled/fit-perf-scheduled.ts [--config <path>] [--dry-run]
 *
 * `--dry-run` forces the config's `variables.dryRun` to true (jenkins-sdk then works
 * out what it would run without actually running it) regardless of what the config
 * file says — a safe way to exercise the whole pipeline by hand.
 *
 * The results-DB password is never written into the config file: it's resolved from AWS
 * Secrets Manager and passed to perf-driver as the FIT_PERF_DB_PASSWORD environment
 * variable (see DB_PASSWORD_ENV_VAR below), staged via a remote env file rather than an
 * inline shell `export` so it doesn't appear in `ps` output or an echoed command.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { isMain } from "../util/non-fit/cli.js";
import { posixQuote, teeToFileCommand } from "../util/non-fit/remote-target.js";
import { parseAllocatedId } from "../cluster/cluster-create/parse-allocated-id.js";
import { parseConnstr } from "../cluster/cluster-select/parse-connstr.js";
import { installCbdinoclusterRemote } from "../cluster/cluster-create/install-cbdinocluster.js";
import { resolveGithubTokenFromAws, resolveResultsDbCredentials } from "../fit/util/config.js";
import { provisionFitInstance, FIT_INSTANCE_USER } from "../fit/util/aws/fit-instance.js";
import { FIT_PERFORMER, repoPath, type Repo } from "../fit/util/repos.js";
import {
  configureRemoteGitCredentials,
  ensureRemoteRepos,
} from "../fit/shared/util/remote-fit-run.js";
import {
  remoteAptCleanupCommand,
  remoteAptGetCommand,
  remoteAptWaitCommand,
} from "../fit/shared/util/remote-fit-execution-context.js";

const DEFAULT_CONFIG_PATH = join(import.meta.dirname, "config", "fit-perf-scheduled.yaml");
// Written to the current directory (the GHA checkout, or wherever this is run from) as
// soon as an instance is provisioned, so a step outside this process — the GHA workflow's
// "Terminate instance if cancelled" — can find and terminate it if this process itself
// gets killed (e.g. a job timeout) before it has a chance to clean up.
const INSTANCE_INFO_PATH = "fit-perf-scheduled-instance.json";
// The env var perf-driver (transactions-fit-performer/perf-driver) reads the results-DB
// password from, in preference to a (no longer written) `database.password` config field.
const DB_PASSWORD_ENV_VAR = "FIT_PERF_DB_PASSWORD";
// A subdirectory of the home dir, not the home dir itself — configureRemoteGitCredentials
// writes a plaintext GitHub token to "<rootDir>/.git-credentials", which we don't want
// sitting at $HOME/.git-credentials (git's own default lookup path) alongside the repos.
const REMOTE_ROOT_DIR = `/home/${FIT_INSTANCE_USER}/fit-perf-scheduled`;

const JENKINS_SDK: Repo = {
  name: "jenkins-sdk",
  dir: "jenkins-sdk",
  sshUrl: "git@github.com:couchbaselabs/jenkins-sdk.git",
  httpsUrl: "https://github.com/couchbaselabs/jenkins-sdk/",
};

const COUCHBASE_JVM_CLIENTS: Repo = {
  name: "couchbase-jvm-clients",
  dir: "couchbase-jvm-clients",
  sshUrl: "git@github.com:couchbase/couchbase-jvm-clients.git",
  httpsUrl: "https://github.com/couchbase/couchbase-jvm-clients/",
};

function parseArgs(argv: string[]): { configPath: string; dryRun: boolean; help: boolean } {
  const configIndex = argv.indexOf("--config");
  return {
    configPath: configIndex !== -1 ? argv[configIndex + 1] : DEFAULT_CONFIG_PATH,
    dryRun: argv.includes("--dry-run"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

function printHelp(): void {
  console.log(`Usage: bun src/fit-perf-scheduled/fit-perf-scheduled.ts [--config <path>] [--dry-run]

Launches a clean EC2 instance, allocates a Couchbase cluster with cbdinocluster,
builds and runs jenkins-sdk against the config, and writes results to the
production perf results database (performance-sdk.couchbase.com).

  --config <path>  Path to the jenkins-sdk config YAML (default: config/fit-perf-scheduled.yaml
                    next to this script — a copy of fit-as-a-service's config).
  --dry-run        Force variables.dryRun=true regardless of what the config says.
  --help, -h       Show this help.

On success the EC2 instance is terminated. On failure it is left running for
debugging — an SSH command is printed above; clean it up yourself, or wait for
the scheduled cleanup-instances.yaml workflow to reap it.
`);
}

/** Everything from the config we actually inspect/mutate; the rest passes through untouched. */
interface JenkinsSdkConfig {
  servers?: { driver?: { source?: string } };
  database?: { username?: string; password?: string };
  variables?: { dryRun?: boolean; [key: string]: unknown };
  matrix?: { clusters?: Array<Record<string, unknown>> };
  [key: string]: unknown;
}

async function main(): Promise<void> {
  const { configPath, dryRun, help } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }

  console.log(`Loading jenkins-sdk config from ${configPath}...`);
  const config = parseYaml(readFileSync(configPath, "utf8")) as JenkinsSdkConfig;

  const cluster0 = config.matrix?.clusters?.[0];
  const cbdinoDef = cluster0?.cbdino;
  if (!cluster0 || !cbdinoDef) {
    throw new Error(`${configPath}: matrix.clusters[0].cbdino is required to allocate a cluster.`);
  }

  if (dryRun) {
    config.variables = { ...config.variables, dryRun: true };
    console.log("--dry-run: forcing variables.dryRun=true");
  }

  console.log("Resolving results-database credentials (results/prod) from AWS Secrets Manager...");
  const dbCreds = await resolveResultsDbCredentials({ block: "prod" });
  // The password is deliberately never written into the config file (it ends up on disk on
  // the EC2 instance, and potentially in uploaded artifacts) — perf-driver reads it from the
  // DB_PASSWORD_ENV_VAR environment variable instead (staged below, once the box exists).
  config.database = { ...config.database, username: dbCreds.username };
  delete config.database.password;
  // Must match wherever we actually clone the repos below (REMOTE_ROOT_DIR), not whatever
  // the config file happens to say — overridden here rather than trusted from the file.
  config.servers = { ...config.servers, driver: { ...config.servers?.driver, source: REMOTE_ROOT_DIR } };

  console.log("Provisioning a clean EC2 instance for the run...");
  const provisioned = await provisionFitInstance({ interactive: false });
  const { target } = provisioned;
  const scratchDir = mkdtempSync(join(tmpdir(), "fit-perf-scheduled-"));

  // Written before anything else so an external cleanup step (the GHA workflow's
  // "Terminate instance if cancelled") can find and terminate this instance even if this
  // process is killed outright rather than getting to run its own catch/cleanup below.
  writeFileSync(INSTANCE_INFO_PATH, JSON.stringify({ instanceId: provisioned.instanceId }));

  try {
    console.log("\nInstalling FIT/PERF dependencies (git, docker, JDK, Maven)...");
    await target.runHiddenUntilFailure("sh", ["-lc", remoteAptWaitCommand()], undefined, { display: "wait for cloud-init/apt" });
    await target.runHiddenUntilFailure("sh", ["-lc", remoteAptCleanupCommand()], undefined, { display: "clear /var/lib/apt/lists contents" });
    await target.runHiddenUntilFailure("sh", ["-lc", remoteAptGetCommand("update")], undefined, { display: "apt-get update" });
    await target.runHiddenUntilFailure(
      "sh",
      ["-lc", remoteAptGetCommand("install -y git docker.io lsof openjdk-21-jdk maven")],
      undefined,
      { display: "apt-get install git docker.io lsof openjdk-21-jdk maven" },
    );
    await target.run("sudo", ["usermod", "-aG", "docker", FIT_INSTANCE_USER]);
    await target.run("sudo", ["-n", "systemctl", "enable", "--now", "docker"]);

    console.log("\nInstalling cbdinocluster...");
    const cbdinocluster = await installCbdinoclusterRemote(target);

    console.log("\nCloning repositories...");
    const githubToken = await resolveGithubTokenFromAws();
    if (!githubToken) {
      throw new Error(
        `No GitHub token found in AWS Secrets Manager (fit-cli/github/token) — can't clone the private repos.`,
      );
    }
    await configureRemoteGitCredentials(target, REMOTE_ROOT_DIR, githubToken);
    await ensureRemoteRepos(target, REMOTE_ROOT_DIR, [FIT_PERFORMER, JENKINS_SDK, COUCHBASE_JVM_CLIENTS]);

    console.log("\nAllocating the Couchbase cluster with cbdinocluster...");
    const defLocalPath = join(scratchDir, "cbdino-def.yaml");
    writeFileSync(defLocalPath, stringifyYaml(cbdinoDef));
    const defRemotePath = `${REMOTE_ROOT_DIR}/cbdino-def.yaml`;
    await target.putFile(defLocalPath, defRemotePath);

    const allocateOutput = await target.capture(cbdinocluster, ["--verbose", "allocate", "--deployer", "docker", `--def-file=${defRemotePath}`]);
    const clusterId = parseAllocatedId(allocateOutput);
    if (!clusterId) throw new Error(`Could not find an allocated cluster id in:\n${allocateOutput}`);
    console.log(`✓ Allocated cluster ${clusterId}`);

    const connstrOutput = await target.capture(cbdinocluster, ["connstr", clusterId]);
    const connstr = parseConnstr(connstrOutput);
    if (!connstr) throw new Error(`Could not find a connection string in:\n${connstrOutput}`);
    const nodeIp = connstr.replace(/^couchbases?:\/\//i, "");
    console.log(`✓ Cluster node at ${nodeIp}`);

    console.log("\nFinalizing config with cluster connection details...");
    delete cluster0.cbdino;
    cluster0.hostname = nodeIp;
    cluster0.hostname_docker = nodeIp;
    cluster0.hostname_rest = `http://${nodeIp}:8091`;
    cluster0.hostname_rest_docker = `http://${nodeIp}:8091`;
    cluster0.connection_string_driver = `couchbase://${nodeIp}`;
    cluster0.connection_string_driver_docker = `couchbase://${nodeIp}`;
    cluster0.connection_string_performer = `couchbase://${nodeIp}`;
    cluster0.connection_string_performer_docker = `couchbase://${nodeIp}`;

    const jenkinsSdkDir = repoPath(JENKINS_SDK, REMOTE_ROOT_DIR);
    const configLocalPath = join(scratchDir, "job-config.yaml");
    writeFileSync(configLocalPath, stringifyYaml(config));
    await target.run("mkdir", ["-p", `${jenkinsSdkDir}/config`]);
    await target.putFile(configLocalPath, `${jenkinsSdkDir}/config/job-config.yaml`);

    console.log("\nBuilding transactions-fit-performer (mvn clean install -Dmaven.test.skip)...");
    await target.run("mvn", ["clean", "install", "-Dmaven.test.skip"], repoPath(FIT_PERFORMER, REMOTE_ROOT_DIR));

    console.log("\nBuilding jenkins-sdk (./gradlew shadowJar)...");
    await target.run("./gradlew", ["shadowJar"], jenkinsSdkDir);

    console.log("\nRunning jenkins-sdk against the config (this can take a long time)...");
    // Resolve the shadowJar output by glob rather than a hardcoded name — the exact jar
    // name is a jenkins-sdk build detail this script shouldn't have to track by hand.
    const jarListing = (await target.capture("sh", ["-lc", "ls build/libs/*-all.jar 2>/dev/null"], jenkinsSdkDir))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (jarListing.length !== 1) {
      throw new Error(
        `Expected exactly one build/libs/*-all.jar after ./gradlew shadowJar, found: ${jarListing.join(", ") || "(none)"}`,
      );
    }
    const [jarPath] = jarListing;

    // Stage the results-DB password as an env file rather than a command-line argument or
    // inline `export` (which would land in `ps` output and the echoed SSH command/log).
    const envFileLocal = join(scratchDir, "driver-env.sh");
    writeFileSync(envFileLocal, `export ${DB_PASSWORD_ENV_VAR}=${posixQuote(dbCreds.password)}\n`, { mode: 0o600 });
    const envFileRemote = `${REMOTE_ROOT_DIR}/.fit-perf-driver-env.sh`;
    await target.putFile(envFileLocal, envFileRemote);
    await target.run("chmod", ["600", envFileRemote]);

    const remoteLogPath = `${jenkinsSdkDir}/logs/jenkins_sdk_run.log`;
    await target.run("mkdir", ["-p", `${jenkinsSdkDir}/logs`]);
    await target.run("sh", ["-lc", teeToFileCommand(`. ${envFileRemote} && java -jar ${jarPath}`, remoteLogPath)], jenkinsSdkDir);

    const localLogPath = join(scratchDir, "jenkins_sdk_run.log");
    await target.getFile(remoteLogPath, localLogPath);
    console.log(`\n✓ jenkins-sdk run succeeded. Log saved to ${localLogPath}`);

    console.log(`\nTerminating instance ${provisioned.instanceId} (run succeeded)...`);
    await provisioned.terminate();
    rmSync(INSTANCE_INFO_PATH, { force: true });
  } catch (err) {
    console.error(
      `\n✗ FIT/PERF run failed — leaving instance ${provisioned.instanceId} running for debugging ` +
        `(see the SSH command printed above). Terminate it yourself when done.`,
    );
    throw err;
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
