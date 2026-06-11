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
    configPath: "/tmp/test-config.json5",
    ...overrides,
  };
}

test("buildAutoConfig: all env vars set produces full config", () => {
  const env = {
    AWS_REGION: "eu-west-1",
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
        region: "eu-west-1",
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
    AWS_REGION: "us-east-2",
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
  const env = { AWS_REGION: "us-east-1", GITHUB_USER: "env-user" };

  const { config } = buildAutoConfig({
    args: baseArgs({ awsRegion: "ap-southeast-1", githubUser: "cli-user" }),
    env,
  });

  assert.equal(config.cloud?.aws?.region, "ap-southeast-1");
  assert.equal(config.github?.user, "cli-user");
});

test("buildAutoConfig: missing optional fields are omitted gracefully", () => {
  const env = {};

  const { config } = buildAutoConfig({ args: baseArgs(), env });

  // cloud.aws gets defaults for region and instance types, so it's present
  assert.equal(config.cloud?.aws?.region, "us-west-2");
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

test("buildAutoConfig: AWS_DEFAULT_REGION is fallback for AWS_REGION", () => {
  const env = { AWS_DEFAULT_REGION: "eu-central-1" };

  const { config } = buildAutoConfig({ args: baseArgs(), env });

  assert.equal(config.cloud?.aws?.region, "eu-central-1");
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
