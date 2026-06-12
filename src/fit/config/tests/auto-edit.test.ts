import assert from "node:assert/strict";
import { test } from "node:test";
import { FIT_CLI_CONFIG_VERSION } from "../../util/config.js";
import { buildAutoConfig } from "../edit.js";
import type { AutoInitCliArgs } from "../config.js";

function baseArgs(overrides: Partial<AutoInitCliArgs> = {}): AutoInitCliArgs {
  return {
    auto: true,
    dryRun: false,
    disableAws: false,
    disableGithub: false,
    disableResultsDb: false,
    disableGerrit: false,
    disableCapella: false,
    configPath: "/tmp/test-config.json5",
    ...overrides,
  };
}

test("buildAutoConfig: all env vars set produces full config", () => {
  const env = {
    AWS_PROFILE: "dev",
    // A single FIT_EC2_INSTANCE_TYPE seeds every purpose; a per-purpose var wins for perf.
    FIT_EC2_INSTANCE_TYPE: "m6i.large",
    FIT_EC2_INSTANCE_TYPE_PERF: "m6i.4xlarge",
    GITHUB_USER: "octocat",
    GITHUB_TOKEN: "ghp_secret",
    FIT_RESULTS_DB_PASSWORD: "dbpass",
    FIT_RESULTS_DB_USERNAME: "dbuser",
  };

  const { config } = buildAutoConfig({ args: baseArgs(), env });

  assert.deepEqual(config, {
    version: FIT_CLI_CONFIG_VERSION,
    cloud: {
      aws: {
        profile: "dev",
        instanceTypes: { functional: "m6i.large", situational: "m6i.large", perf: "m6i.4xlarge" },
      },
    },
    github: { user: "octocat", token: "ghp_secret" },
    resultsDb: { password: "dbpass", username: "dbuser" },
  });
});

test("buildAutoConfig: --disable-aws omits cloud section", () => {
  const env = {
    AWS_PROFILE: "dev",
    GITHUB_USER: "octocat",
    GITHUB_TOKEN: "ghp_t",
  };

  const { config } = buildAutoConfig({ args: baseArgs({ disableAws: true }), env });

  assert.equal(config.cloud, undefined);
  assert.equal(config.github?.user, "octocat");
});

test("buildAutoConfig: --disable-github omits github section", () => {
  const env = { GITHUB_TOKEN: "ghp_t" };

  const { config } = buildAutoConfig({ args: baseArgs({ disableGithub: true }), env });

  assert.equal(config.github, undefined);
});

test("buildAutoConfig: --disable-results-db omits resultsDb section", () => {
  const env = { FIT_RESULTS_DB_PASSWORD: "secret" };

  const { config } = buildAutoConfig({ args: baseArgs({ disableResultsDb: true }), env });

  assert.equal(config.resultsDb, undefined);
});

test("buildAutoConfig: CLI arg overrides env var", () => {
  const env = { GITHUB_USER: "env-user" };

  const { config } = buildAutoConfig({
    args: baseArgs({ githubUser: "cli-user" }),
    env,
  });

  assert.equal(config.github?.user, "cli-user");
});

test("buildAutoConfig: missing optional fields are omitted gracefully", () => {
  const env = {};

  const { config } = buildAutoConfig({ args: baseArgs(), env });

  // cloud.aws gets defaults for instance types, so it's present
  assert.equal(config.cloud?.aws?.instanceTypes?.functional, "c5.xlarge");
  assert.equal(config.cloud?.aws?.instanceTypes?.perf, "c5.4xlarge");
  assert.equal(config.cloud?.aws?.profile, undefined);
  // github and resultsDb have no defaults, so they're omitted
  assert.equal(config.github, undefined);
  assert.equal(config.resultsDb, undefined);
});

test("buildAutoConfig: GH_TOKEN is used as fallback for github.token", () => {
  const env = { GH_TOKEN: "ghp_fallback" };

  const { config } = buildAutoConfig({ args: baseArgs(), env });

  assert.equal(config.github?.token, "ghp_fallback");
});

test("buildAutoConfig: GITHUB_TOKEN takes precedence over GH_TOKEN", () => {
  const env = { GITHUB_TOKEN: "ghp_primary", GH_TOKEN: "ghp_fallback" };

  const { config } = buildAutoConfig({ args: baseArgs(), env });

  assert.equal(config.github?.token, "ghp_primary");
});

test("buildAutoConfig: CAP_* env (fit-app-deployment names) populates capella with defaults filled in", () => {
  const env = {
    CAP_USER: "graham.pople@couchbase.com",
    CAP_OID: "org-from-env",
  };

  const { config } = buildAutoConfig({ args: baseArgs(), env });

  assert.deepEqual(config.capella, {
    username: "graham.pople@couchbase.com",
    endpoint: "https://api.dev.nonprod-project-avengers.com",
    organizationId: "org-from-env",
    password: "NotUsed",
    overrideToken: "the-secret-test-override-key",
    internalSupportToken: "the-secret-token-for-internal-support",
  });
});

test("buildAutoConfig: CAPELLA_* takes precedence over CAP_* aliases", () => {
  const env = { CAPELLA_USER: "primary@cb.com", CAP_USER: "alias@cb.com" };

  const { config } = buildAutoConfig({ args: baseArgs(), env });

  assert.equal(config.capella?.username, "primary@cb.com");
});

test("buildAutoConfig: capella section omitted when no username is resolvable", () => {
  // Endpoint/oid/etc all have defaults, but with no username there's nothing to log in as.
  const { config } = buildAutoConfig({ args: baseArgs(), env: { CAP_OID: "org" } });

  assert.equal(config.capella, undefined);
});

test("buildAutoConfig: --disable-capella omits capella even with a username present", () => {
  const { config } = buildAutoConfig({ args: baseArgs({ disableCapella: true }), env: { CAP_USER: "u@cb.com" } });

  assert.equal(config.capella, undefined);
});

test("buildAutoConfig: resolution log records all checks in order", () => {
  const env = { GITHUB_TOKEN: "ghp_xxx" };

  const { log } = buildAutoConfig({ args: baseArgs({ disableAws: true }), env });

  // Should have the disable-aws entry
  const awsEntry = log.find((e) => e.field === "cloud.aws.*");
  assert.ok(awsEntry);
  assert.equal(awsEntry.found, false);
  assert.equal(awsEntry.source, "--disable-aws");

  // github.token should show CLI arg not found, then GITHUB_TOKEN found
  const tokenEntries = log.filter((e) => e.field === "github.token");
  assert.ok(tokenEntries.length >= 2);
  assert.equal(tokenEntries[0].source, "--github-token");
  assert.equal(tokenEntries[0].found, false);
  assert.equal(tokenEntries[1].source, "$GITHUB_TOKEN");
  assert.equal(tokenEntries[1].found, true);
});
