/**
 * fit-perf-scheduled — run FIT/PERF (SDK performance testing) on a clean, throwaway
 * EC2 instance.
 *
 * Run on its own:
 *   bun src/fit-perf-scheduled/fit-perf-scheduled.ts [--config <path>] [--dry-run]
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
import { resolveGithubTokenFromAws } from "../fit/util/config.js";
import { loadEnvironments } from "../fit/util/environments.js";
import { provisionFitInstance, FIT_INSTANCE_USER } from "../fit/util/aws/fit-instance.js";
import { FIT_PERFORMER, repoPath, type Repo } from "../fit/util/repos.js";
import { checkAwsCredentials } from "../cloud/util/aws/identity.js";
import { AWS_REGION } from "../cloud/util/aws/aws-target.js";
import {
  configureRemoteGitCredentials,
  ensureRemoteRepos,
  uploadRemoteAwsCredentials,
} from "../fit/shared/util/remote-fit-run.js";
import {
  remoteAptCleanupCommand,
  remoteAptGetCommand,
  remoteAptWaitCommand,
} from "../fit/shared/util/remote-fit-execution-context.js";

const DEFAULT_CONFIG_PATH = join(import.meta.dirname, "config", "fit-perf-scheduled.yaml");
const INSTANCE_INFO_PATH = "fit-perf-scheduled-instance.json";
const DB_PASSWORD_ENV_VAR = "FIT_PERF_DB_PASSWORD";
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

function parseArgs(argv: string[]): { configPath: string; dryRun: boolean; keepOnFailure: boolean; help: boolean } {
  const configIndex = argv.indexOf("--config");
  return {
    configPath: configIndex !== -1 ? argv[configIndex + 1] : DEFAULT_CONFIG_PATH,
    dryRun: argv.includes("--dry-run"),
    keepOnFailure: argv.includes("--keep-on-failure"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

function printHelp(): void {
  console.log(`Usage: bun src/fit-perf-scheduled/fit-perf-scheduled.ts [--config <path>] [--dry-run] [--keep-on-failure]

Launches a clean EC2 instance, allocates a Couchbase cluster with cbdinocluster,
builds and runs jenkins-sdk against the config, and writes results to the
production perf results database (performance-sdk.couchbase.com).

  --config <path>     Path to the jenkins-sdk config YAML (default: config/fit-perf-scheduled.yaml
                      next to this script — a copy of fit-as-a-service's config).
  --dry-run           Force variables.dryRun=true regardless of what the config says.
  --keep-on-failure   Leave the EC2 instance running for debugging if the run fails.
                      Default is to terminate it on failure too — only this flag keeps it up.
  --help, -h          Show this help.
`);
}

/** Everything from the config we actually inspect/mutate; the rest passes through untouched. */
interface JenkinsSdkConfig {
  servers?: { driver?: { source?: string } };
  variables?: { dryRun?: boolean; [key: string]: unknown };
  matrix?: { clusters?: Array<Record<string, unknown>> };
  [key: string]: unknown;
}

async function main(): Promise<void> {
  const { configPath, dryRun, keepOnFailure, help } = parseArgs(process.argv.slice(2));
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

  // The results-DB password is never resolved here, written into the config file, or handled by
  // this process at all — it's fetched by the instance itself, directly from AWS Secrets Manager,
  // once AWS credentials have been forwarded to it (see below). perf-driver reads it from the
  // DB_PASSWORD_ENV_VAR environment variable.
  const resultsSecretId = loadEnvironments().results.prod?.secretId;
  if (!resultsSecretId) {
    throw new Error(`No secretId configured for the "prod" results environment in environments.json5.`);
  }

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
    console.log("\nInstalling FIT/PERF dependencies...");
    await target.runHiddenUntilFailure("sh", ["-lc", remoteAptWaitCommand()], undefined, { display: "wait for cloud-init/apt" });
    await target.runHiddenUntilFailure("sh", ["-lc", remoteAptCleanupCommand()], undefined, { display: "clear /var/lib/apt/lists contents" });
    await target.runHiddenUntilFailure("sh", ["-lc", remoteAptGetCommand("update")], undefined, { display: "apt-get update" });
    await target.runHiddenUntilFailure(
      "sh",
      ["-lc", remoteAptGetCommand("install -y git docker.io lsof openjdk-21-jdk maven awscli jq")],
      undefined,
      { display: "apt-get install git docker.io lsof openjdk-21-jdk maven awscli jq" },
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

    console.log("\nForwarding AWS credentials to the instance (so it can fetch the results-DB password itself)...");
    const awsCreds = await checkAwsCredentials();
    if (!awsCreds.ok) throw new Error(`AWS credentials are not usable: ${awsCreds.message}`);
    await uploadRemoteAwsCredentials(target, REMOTE_ROOT_DIR, awsCreds.credentials);

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

    // Fetch the results-DB password directly on the instance — it never passes through this
    // process or over SCP, only through the box's own (encrypted) call to Secrets Manager.
    // `@sh` shell-quotes the value so it's safe to source regardless of its contents.
    const envFileRemote = `${REMOTE_ROOT_DIR}/.fit-perf-driver-env.sh`;
    await target.run(
      "sh",
      [
        "-lc",
        `set -o pipefail; aws secretsmanager get-secret-value --secret-id ${posixQuote(resultsSecretId)} ` +
          `--region ${posixQuote(AWS_REGION)} --query SecretString --output text ` +
          `| jq -r '"export ${DB_PASSWORD_ENV_VAR}=" + (.password | @sh)' > ${posixQuote(envFileRemote)}`,
      ],
      undefined,
      { display: `fetch ${DB_PASSWORD_ENV_VAR} from AWS Secrets Manager (${resultsSecretId}) on the instance` },
    );
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
    if (keepOnFailure) {
      console.error(
        `\n✗ FIT/PERF run failed — --keep-on-failure was passed, so instance ${provisioned.instanceId} is ` +
          `being left running for debugging (see the SSH command printed above). Terminate it yourself when done.`,
      );
    } else {
      console.error(`\n✗ FIT/PERF run failed — terminating instance ${provisioned.instanceId}...`);
      try {
        await provisioned.terminate();
        rmSync(INSTANCE_INFO_PATH, { force: true });
      } catch (terminateErr) {
        console.error(
          `✗ Also failed to terminate instance ${provisioned.instanceId} — you'll need to clean it up yourself: ` +
            (terminateErr instanceof Error ? terminateErr.message : String(terminateErr)),
        );
      }
    }
    throw err;
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
