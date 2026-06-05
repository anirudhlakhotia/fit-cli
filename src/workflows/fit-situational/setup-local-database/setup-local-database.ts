/**
 * Workflow: set up a local results database for situational testing, the
 * alternative to the hosted faas.couchbase.com database. It puts a timescaledb
 * container on a dedicated `fit` Docker network and asks jenkins-sdk to create
 * the schema (`./gradlew setupPerfDatabase`).
 *
 * The golden rule from the FIT docs: everything that needs to talk to each other
 * lives on the same Docker network — here, `fit`.
 *
 * Run on its own (this really does start Docker containers; add --root <dir>):
 *   npx tsx src/workflows/fit-situational/setup-local-database/setup-local-database.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { type RunOutput } from "../../../util/non-fit/artifacts.js";
import { capture, run } from "../../../util/non-fit/proc.js";
import { JENKINS_SDK, repoPath } from "../../../util/fit/repos.js";
import { ensureRepo } from "../../../util/fit/ensure-repo.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { type ResultsDatabase } from "../util/situational-config.js";

/** The Docker network every situational container shares. */
export const FIT_DOCKER_NETWORK = "fit";
const TIMESCALE_IMAGE = "timescale/timescaledb:latest-pg14";
const DB_CONTAINER = "timedb";
const DB_NAME = "perf";
const DB_PASSWORD = "password";

/** The connection details for the local Docker database (reached from the host). */
export function localDatabaseConnection(): ResultsDatabase {
  return {
    jdbc: `jdbc:postgresql://localhost:5432/${DB_NAME}`,
    username: "postgres",
    password: DB_PASSWORD,
  };
}

export type LocalDatabaseOutcome =
  | (RunOutput & { ready: true; database: ResultsDatabase })
  | (RunOutput & { ready: false });

/** True if a Docker object the `--format {{.Name}}`/`{{.Names}}` query lists exists. */
async function dockerNameExists(args: string[], name: string): Promise<boolean> {
  try {
    const output = await capture("docker", args);
    return output.split(/\r?\n/).map((line) => line.trim()).includes(name);
  } catch {
    return false;
  }
}

/** Create the `fit` Docker network if it isn't already there. */
async function ensureFitNetwork(): Promise<void> {
  const exists = await dockerNameExists(
    ["network", "ls", "--filter", `name=^${FIT_DOCKER_NETWORK}$`, "--format", "{{.Name}}"],
    FIT_DOCKER_NETWORK,
  );
  if (exists) {
    console.log(`\n→ Reusing the existing \`${FIT_DOCKER_NETWORK}\` Docker network.`);
    return;
  }
  console.log(`\nCreating the \`${FIT_DOCKER_NETWORK}\` Docker network:\n  docker network create -d bridge ${FIT_DOCKER_NETWORK}\n`);
  await run("docker", ["network", "create", "-d", "bridge", FIT_DOCKER_NETWORK]);
}

/** Start the timescaledb container on the `fit` network if it isn't already running. */
async function ensureDatabaseContainer(): Promise<void> {
  const running = await dockerNameExists(
    ["ps", "--filter", `name=^${DB_CONTAINER}$`, "--format", "{{.Names}}"],
    DB_CONTAINER,
  );
  if (running) {
    console.log(`\n→ Reusing the running \`${DB_CONTAINER}\` database container.`);
    return;
  }

  const args = [
    "run", "-d", "--restart=always",
    "-p", "5432:5432",
    "-e", `POSTGRES_PASSWORD=${DB_PASSWORD}`,
    "--network", FIT_DOCKER_NETWORK,
    "--name", DB_CONTAINER,
    TIMESCALE_IMAGE,
  ];
  console.log(`\nStarting the results database:\n  docker ${args.join(" ")}\n`);
  await run("docker", args);

  // First boot needs the `perf` database; a re-run will already have it, so
  // ignore the "already exists" failure rather than treating it as fatal.
  try {
    await run("docker", ["exec", DB_CONTAINER, "psql", "-U", "postgres", "-c", `CREATE DATABASE ${DB_NAME};`]);
  } catch {
    console.log(`\n→ Database \`${DB_NAME}\` already exists; leaving it as is.`);
  }
}

/** Stand up the local results database and create its schema. */
export async function setupLocalDatabase(rootDir: string): Promise<LocalDatabaseOutcome> {
  if (!(await ensureRepo(JENKINS_SDK, rootDir))) {
    console.log("\nOnce jenkins-sdk is in place, run fit-cli again.");
    return { ready: false, artifacts: [], details: [] };
  }

  try {
    await ensureFitNetwork();
    await ensureDatabaseContainer();

    const jenkinsDir = repoPath(JENKINS_SDK, rootDir);
    console.log(`\nCreating the results schema:\n  cd ${jenkinsDir} && ./gradlew setupPerfDatabase\n`);
    await run("./gradlew", ["setupPerfDatabase"], jenkinsDir);
  } catch (err) {
    console.error(`\n✗ Could not set up the local results database: ${(err as Error).message}`);
    return { ready: false, artifacts: [], details: [] };
  }

  const database = localDatabaseConnection();
  console.log(`\n✓ Local results database ready at ${database.jdbc}`);
  return {
    ready: true,
    database,
    artifacts: [],
    details: [{ label: "Results database", value: `local Docker (${DB_CONTAINER} on ${FIT_DOCKER_NETWORK})` }],
  };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    const outcome = await setupLocalDatabase(rootDir);
    return { artifacts: outcome.artifacts, details: outcome.details };
  });
}
