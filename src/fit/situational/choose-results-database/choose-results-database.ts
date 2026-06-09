/**
 * Workflow: choose where situational test results are stored. The hosted
 * database on faas.couchbase.com is the recommended default (no local database
 * or results UI to run); the alternative is a local Docker database, which this
 * workflow can set up via ../setup-local-database.
 *
 * The hosted database's readonly password is secret, so it's taken from the
 * fit-cli config (`resultsDb.password` in ~/.fit-cli/config.yaml), falling back
 * to the FIT_RESULTS_DB_PASSWORD environment variable (a `.env` file is loaded
 * automatically) rather than prompted for and logged. Ask on #the-fit-stop for
 * the password — see .env.example.
 *
 * Run on its own (add --root <dir> to point elsewhere):
 *   npx tsx src/fit/situational/choose-results-database/choose-results-database.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { type RunOutput } from "../../../util/non-fit/artifacts.js";
import { loadDotenv } from "../../../util/non-fit/dotenv.js";
import { resolveResultsDbCredentials } from "../../util/config.js";
import { fitCliError } from "../../../util/non-fit/fit-cli-log.js";
import { capture } from "../../../util/non-fit/proc.js";
import { qualifyPromptId, select } from "../../../util/non-fit/prompts.js";
import { rootDirFromArgv } from "../../util/root.js";
import { type ResultsDatabase } from "../../shared/util/results-database.js";
import { setupLocalDatabase } from "../setup-local-database/setup-local-database.js";

export const HOSTED_RESULTS_DB_HOST = "faas.couchbase.com";
export const HOSTED_RESULTS_DB_JDBC = `jdbc:postgresql://${HOSTED_RESULTS_DB_HOST}:5432/perf`;
export const HOSTED_RESULTS_DB_USERNAME = "postgres";
/** Environment variable used as a fallback for the hosted results-DB password. */
export const RESULTS_DB_PASSWORD_ENV = "FIT_RESULTS_DB_PASSWORD";

/** Where situational results show up once a run has produced data. */
export const SITUATIONAL_RESULTS_URL = "https://performance-sdk.couchbase.com/results/situational";

export type ResultsDatabaseMode = "hosted" | "local";

/** The outcome of choosing a results database. */
export type ResultsDatabaseOutcome =
  | (RunOutput & { ready: true; database: ResultsDatabase })
  | (RunOutput & { ready: false });

/**
 * Build the hosted database connection from resolved credentials, or `undefined`
 * if no password is available. Pure (takes the credentials in) so it's easy to
 * unit test; see {@link resolveResultsDbCredentials} for where they come from.
 */
export function buildHostedDatabase(
  credentials: { password?: string; username?: string } = {},
): ResultsDatabase | undefined {
  const password = credentials.password?.trim();
  if (!password) {
    return undefined;
  }
  return {
    jdbc: HOSTED_RESULTS_DB_JDBC,
    username: credentials.username?.trim() || HOSTED_RESULTS_DB_USERNAME,
    password,
  };
}

/**
 * TCP connectivity probe: returns true if the hosted results database is
 * reachable on its PostgreSQL port, false if not (VPN likely not active).
 * Pass a `captureCommand` to run the check from a remote execution context.
 */
export async function checkResultsDatabaseConnectivity(
  captureCommand?: (cmd: string, args: string[]) => Promise<string>,
): Promise<boolean> {
  const run = captureCommand ?? ((cmd: string, args: string[]) => capture(cmd, args));
  try {
    await run("nc", ["-z", "-w", "5", HOSTED_RESULTS_DB_HOST, "5432"]);
    return true;
  } catch {
    return false;
  }
}

export async function chooseResultsDatabaseMode(promptIdPrefix?: string): Promise<ResultsDatabaseMode> {
  return select<ResultsDatabaseMode>({
    promptId: qualifyPromptId("situational.database.mode", promptIdPrefix),
    message: "Where should situational test results be stored?",
    default: "hosted",
    choices: [
      {
        name: `Hosted database on ${HOSTED_RESULTS_DB_HOST} (recommended — nothing to run locally)`,
        value: "hosted",
      },
      { name: "A local database in Docker (this tool will set it up)", value: "local" },
    ],
  });
}

/** Resolve the hosted database, explaining how to fix a missing password. */
function resolveHostedDatabase(): ResultsDatabaseOutcome {
  loadDotenv();
  const database = buildHostedDatabase(resolveResultsDbCredentials());
  if (!database) {
    fitCliError(
      `\n✗ The hosted results database needs a readonly password.\n` +
        `  Ask on #the-fit-stop for it, then set it as resultsDb.password in your fit-cli config\n` +
        `  (~/.fit-cli/config.yaml — run \`npm run init\`) or ${RESULTS_DB_PASSWORD_ENV} in your .env (see .env.example).\n` +
        `  You must also be on the vpn-public VPN to reach ${HOSTED_RESULTS_DB_HOST}.`,
    );
    return { ready: false, artifacts: [], details: [] };
  }
  console.log(`\n✓ Using the hosted results database at ${HOSTED_RESULTS_DB_HOST}.`);
  return {
    ready: true,
    database,
    artifacts: [],
    details: [{ label: "Results database", value: HOSTED_RESULTS_DB_HOST }],
  };
}

/**
 * Resolve the hosted database from the fit-cli config only — no `.env` /
 * environment-variable fallback. Used by the definition-driven situational run,
 * where the password must come from the saved config rather than ambient env.
 */
function resolveHostedDatabaseFromConfig(): ResultsDatabaseOutcome {
  const database = buildHostedDatabase(resolveResultsDbCredentials({ env: {} }));
  if (!database) {
    fitCliError(
      `\n✗ The hosted results database needs a readonly password in your fit-cli config.\n` +
        `  Ask on #the-fit-stop for it, then set it as resultsDb.password in your fit-cli config\n` +
        `  (~/.fit-cli/config.yaml — run \`npm run init\`).\n` +
        `  You must also be on the vpn-public VPN to reach ${HOSTED_RESULTS_DB_HOST}.`,
    );
    return { ready: false, artifacts: [], details: [] };
  }
  console.log(`\n✓ Using the hosted results database at ${HOSTED_RESULTS_DB_HOST}.`);
  return {
    ready: true,
    database,
    artifacts: [],
    details: [{ label: "Results database", value: HOSTED_RESULTS_DB_HOST }],
  };
}

/**
 * Resolve a results database for a non-interactive (definition-driven) run from
 * a mode named in the file: `hosted` (password from fit-cli config only) or
 * `local` (stood up in Docker). Nothing is prompted for.
 */
export async function resolveResultsDatabase(
  mode: "hosted" | "local",
  rootDir: string,
): Promise<ResultsDatabaseOutcome> {
  if (mode === "local") {
    const local = await setupLocalDatabase(rootDir);
    if (!local.ready) {
      return { ready: false, artifacts: local.artifacts, details: local.details };
    }
    return { ready: true, database: local.database, artifacts: local.artifacts, details: local.details };
  }
  return resolveHostedDatabaseFromConfig();
}

/** Choose a results database: the hosted one, or a freshly set-up local one. */
export async function chooseResultsDatabase(rootDir: string): Promise<ResultsDatabaseOutcome> {
  const mode = await chooseResultsDatabaseMode();
  if (mode === "hosted") {
    return resolveHostedDatabase();
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
