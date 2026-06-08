/**
 * The shared results-database connection contract. Situational and performance
 * runs both store their timeseries results in a Postgres/Timescale database;
 * this is the small, flavour-agnostic shape passed from "choose a database" to
 * the config builders. Kept on its own (rather than in a workflow file) so both
 * fit-shared/choose-results-database and the situational config builder can
 * depend on it without reaching across feature folders.
 */

/** Where test results are stored (a Postgres/Timescale database). */
export interface ResultsDatabase {
  /** JDBC URL, e.g. jdbc:postgresql://faas.couchbase.com:5432/perf. */
  jdbc: string;
  username: string;
  password: string;
}
