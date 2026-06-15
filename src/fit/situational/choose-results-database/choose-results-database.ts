/**
 * Workflow: choose where situational test results are stored. The hosted database
 * (the results environment selected in the definition file — "dev"=faas,
 * "prod"=performance-sdk; default dev) is the recommended default; the alternative
 * is a local Docker database, which this workflow can set up via ../setup-local-database.
 *
 * The hosted database's password is secret and comes from that results environment's
 * AWS Secrets Manager secret (see resolveResultsDbCredentials / environments.json5),
 * resolved with the ambient AWS credentials rather than prompted for or stored.
 *
 * Run on its own (add --root <dir> to point elsewhere):
 *   bun run src/fit/situational/choose-results-database/choose-results-database.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { type RunOutput } from "../../../util/non-fit/artifacts.js";
import { resolveResultsDbCredentials, DEFAULT_RESULTS_ENV, type ResolvedResultsDbCredentials } from "../../util/config.js";
import { fitCliError } from "../../../util/non-fit/fit-cli-log.js";
import { capture } from "../../../util/non-fit/proc.js";
import { qualifyPromptId, select } from "../../../util/non-fit/prompts.js";
import { loadEnvironments } from "../../util/environments.js";
import { rootDirFromArgv } from "../../util/root.js";
import { type ResultsDatabase } from "../../shared/util/results-database.js";
import { setupLocalDatabase } from "../setup-local-database/setup-local-database.js";

/** Default hosted results host, used for connectivity defaults and JDBC parsing fallbacks. */
export const DEFAULT_RESULTS_HOST = "faas.couchbase.com";
export const HOSTED_RESULTS_DB_USERNAME = "postgres";

/** JDBC URL for the Postgres results database on `host`. */
export function resultsDbJdbc(host: string): string {
  return `jdbc:postgresql://${host}:5432/perf`;
}

/** Where situational results show up once a run has produced data (the UI on `host`). */
export function situationalResultsUrl(host: string): string {
  return `https://${host}/results/situational`;
}

/** Extract the host from a results-DB JDBC URL, falling back to the default. */
export function resultsHostFromJdbc(jdbc: string): string {
  return /\/\/([^:/]+)/.exec(jdbc)?.[1] ?? DEFAULT_RESULTS_HOST;
}

export type ResultsDatabaseMode = "hosted" | "local";

/** The outcome of choosing a results database. */
export type ResultsDatabaseOutcome =
  | (RunOutput & { ready: true; database: ResultsDatabase })
  | (RunOutput & { ready: false });

/**
 * Build the hosted database connection from resolved credentials. Pure (takes the
 * credentials in) so it's easy to unit test; see {@link resolveResultsDbCredentials}
 * for where they come from (the JDBC host selects the results environment).
 */
export function buildHostedDatabase(credentials: ResolvedResultsDbCredentials): ResultsDatabase {
  return {
    jdbc: resultsDbJdbc(credentials.host),
    username: credentials.username,
    password: credentials.password,
  };
}

/**
 * TCP connectivity probe: returns true if the hosted results database is reachable
 * on its PostgreSQL port, false if not (VPN likely not active). Pass a
 * `captureCommand` to run the check from a remote execution context.
 */
export async function checkResultsDatabaseConnectivity(
  captureCommand?: (cmd: string, args: string[]) => Promise<string>,
  host: string = DEFAULT_RESULTS_HOST,
): Promise<boolean> {
  const run = captureCommand ?? ((cmd: string, args: string[]) => capture(cmd, args));
  try {
    await run("nc", ["-z", "-w", "5", host, "5432"]);
    return true;
  } catch {
    return false;
  }
}

/** Where situational results will be stored: a hosted environment (with its host), or local Docker. */
export interface ResultsTarget {
  mode: ResultsDatabaseMode;
  /** The chosen results environment; only set when mode is "hosted". */
  resultsEnvironment?: string;
}

/**
 * Single prompt for where situational results go: each hosted results environment
 * (showing the host data lands on), or a local Docker database. Combines the
 * hosted-vs-local and which-environment choices so the user picks once. Sourced
 * from environments.json5.
 */
export async function chooseResultsTarget(promptIdPrefix?: string): Promise<ResultsTarget> {
  const results = loadEnvironments().results;
  const hostedChoices = Object.entries(results).map(([name, env]) => {
    const recommended = name === DEFAULT_RESULTS_ENV ? " (for iterating)" : " (for 'production' results)";
    return { name: `Hosted "${name}" results database at ${env.host ?? "(host not set)"}${recommended}`, value: `hosted:${name}` };
  });
  const choice = await select<string>({
    promptId: qualifyPromptId("situational.database.target", promptIdPrefix),
    message: "Where should situational test results be stored?",
    default: `hosted:${DEFAULT_RESULTS_ENV}`,
    choices: [...hostedChoices, { name: "A local database in Docker (this tool will set it up)", value: "local" }],
  });
  if (choice === "local") return { mode: "local" };
  return { mode: "hosted", resultsEnvironment: choice.slice("hosted:".length) };
}

/** Resolve the hosted database for a results environment from AWS Secrets Manager. */
async function resolveHostedDatabase(block: string): Promise<ResultsDatabaseOutcome> {
  try {
    const credentials = await resolveResultsDbCredentials({ block });
    console.log(`\n✓ Using the "${block}" hosted results database at ${credentials.host}.`);
    return {
      ready: true,
      database: buildHostedDatabase(credentials),
      artifacts: [],
      details: [{ label: "Results database", value: credentials.host }],
    };
  } catch (err) {
    fitCliError(`${(err as Error).message}\n  You must also be on the vpn-public VPN to reach the database.`);
    return { ready: false, artifacts: [], details: [] };
  }
}

/**
 * Resolve a results database for a non-interactive (definition-driven) run: the
 * `mode` from the file (`hosted` or `local`) and the selected results `block`.
 * Nothing is prompted for.
 */
export async function resolveResultsDatabase(
  mode: "hosted" | "local",
  block: string,
  rootDir: string,
): Promise<ResultsDatabaseOutcome> {
  if (mode === "local") {
    const local = await setupLocalDatabase(rootDir);
    if (!local.ready) {
      return { ready: false, artifacts: local.artifacts, details: local.details };
    }
    return { ready: true, database: local.database, artifacts: local.artifacts, details: local.details };
  }
  return resolveHostedDatabase(block);
}

/** Choose a results database interactively: a hosted environment, or a freshly set-up local one. */
export async function chooseResultsDatabase(rootDir: string): Promise<ResultsDatabaseOutcome> {
  const target = await chooseResultsTarget();
  if (target.mode === "hosted") {
    return resolveHostedDatabase(target.resultsEnvironment ?? DEFAULT_RESULTS_ENV);
  }

  const local = await setupLocalDatabase(rootDir);
  if (!local.ready) {
    return { ready: false, artifacts: local.artifacts, details: local.details };
  }
  return { ready: true, database: local.database, artifacts: local.artifacts, details: local.details };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    const outcome = await chooseResultsDatabase(rootDir);
    if (outcome.ready) {
      console.log(`\nResults database JDBC: ${outcome.database.jdbc}`);
    }
    return { artifacts: outcome.artifacts, details: outcome.details };
  });
}
