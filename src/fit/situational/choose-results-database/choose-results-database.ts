/**
 * Workflow: choose which hosted database situational test results are stored in
 * (the results environment selected in the definition file — "dev"=faas,
 * "prod"=performance-sdk; default dev).
 *
 * The hosted database's password is secret and comes from that results environment's
 * AWS Secrets Manager secret (see resolveResultsDbCredentials / environments.json5),
 * resolved with the ambient AWS credentials rather than prompted for or stored.
 *
 * Run on its own:
 *   bun run src/fit/situational/choose-results-database/choose-results-database.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { type RunOutput } from "../../../util/non-fit/artifacts.js";
import { resolveResultsDbCredentials, DEFAULT_RESULTS_ENV, type ResolvedResultsDbCredentials } from "../../util/config.js";
import { fitCliError } from "../../../util/non-fit/fit-cli-log.js";
import { capture } from "../../../util/non-fit/proc.js";
import { qualifyPromptId, select } from "../../../util/non-fit/prompts.js";
import { loadEnvironments } from "../../util/environments.js";
import { type ResultsDatabase } from "../../shared/util/results-database.js";

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

/** Which hosted environment situational results will be stored in (its host). */
export interface ResultsTarget {
  mode: "hosted";
  /** The chosen results environment. */
  resultsEnvironment: string;
}

/**
 * Prompt for which hosted results environment situational results go to (showing
 * the host data lands on). Sourced from environments.json5. The local Docker
 * database option was removed along with jenkins-sdk.
 */
export async function chooseResultsTarget(promptIdPrefix?: string): Promise<ResultsTarget> {
  const results = loadEnvironments().results;
  const hostedChoices = Object.entries(results).map(([name, env]) => {
    const recommended = name === "dev" ? " (for iterating)" : " (for 'production' results)";
    return { name: `Hosted "${name}" results database at ${env.host ?? "(host not set)"}${recommended}`, value: `hosted:${name}` };
  });
  const choice = await select<string>({
    promptId: qualifyPromptId("situational.database.target", promptIdPrefix),
    message: "Which hosted results database should situational test results be stored in?",
    default: `hosted:${DEFAULT_RESULTS_ENV}`,
    choices: hostedChoices,
  });
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
 * Resolve a results database for a non-interactive (definition-driven) run from
 * the selected results `block`. The local Docker database mode was removed along
 * with jenkins-sdk; a definition asking for `local` fails fast with guidance.
 */
export async function resolveResultsDatabase(
  mode: ResultsDatabaseMode,
  block: string,
): Promise<ResultsDatabaseOutcome> {
  if (mode === "local") {
    fitCliError(
      "The local Docker results database is no longer supported (it was removed with jenkins-sdk).\n" +
        "  Set the situational database mode to \"hosted\" and pick a results environment instead.",
    );
    return { ready: false, artifacts: [], details: [] };
  }
  return resolveHostedDatabase(block);
}

/** Choose a hosted results database interactively. */
export async function chooseResultsDatabase(): Promise<ResultsDatabaseOutcome> {
  const target = await chooseResultsTarget();
  return resolveHostedDatabase(target.resultsEnvironment ?? DEFAULT_RESULTS_ENV);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const outcome = await chooseResultsDatabase();
    if (outcome.ready) {
      console.log(`\nResults database JDBC: ${outcome.database.jdbc}`);
    }
    return { artifacts: outcome.artifacts, details: outcome.details };
  });
}
