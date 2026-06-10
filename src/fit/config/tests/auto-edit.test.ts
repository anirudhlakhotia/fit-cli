import assert from "node:assert/strict";
import { test } from "node:test";
import { FIT_CLI_CONFIG_VERSION } from "../../util/config.js";
import { buildAutoConfig, type AutoInitOptions } from "../edit.js";
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
    FIT_EC2_INSTANCE_TYPE: "m6i.large",
    GITHUB_USER: "octocat",
    GITHUB_TOKEN: "ghp_secret",
    FIT_RESULTS_DB_PASSWORD: "dbpass",
    FIT_RESULTS_DB_USERNAME: "dbuser",
  };

  const { config } = buildAutoConfig({ args: baseArgs(), env });

  assert.deepEqual(config, {
    version: FIT_CLI_CONFIG_VERSION,
    aws: { region: "eu-west-1", profile: "dev", instanceType: "m6i.large" },
    github: { user: "octocat", token: "ghp_secret" },
    resultsDb: { password: "dbpass", username: "dbuser" },
  });
});

test("buildAutoConfig: --disable-aws omits aws section", () => {
  const env = {
    AWS_REGION: "us-east-2",
    GITHUB_USER: "octocat",
    GITHUB_TOKEN: "ghp_t",
  };

  const { config } = buildAutoConfig({ args: baseArgs({ disableAws: true }), env });

  assert.equal(config.aws, undefined);
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

  assert.equal(config.aws?.region, "ap-southeast-1");
  assert.equal(config.github?.user, "cli-user");
});

test("buildAutoConfig: missing optional fields are omitted gracefully", () => {
  const env = {};

  const { config } = buildAutoConfig({ args: baseArgs(), env });

  // aws gets defaults for region and instanceType, so it's present
  assert.equal(config.aws?.region, "us-west-2");
  assert.equal(config.aws?.instanceType, "c5.xlarge");
  assert.equal(config.aws?.profile, undefined);
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

  assert.equal(config.aws?.region, "eu-central-1");
});

test("buildAutoConfig: resolution log records all checks in order", () => {
  const env = { GITHUB_TOKEN: "ghp_xxx" };

  const { log } = buildAutoConfig({ args: baseArgs({ disableAws: true }), env });

  // Should have the disable-aws entry
  const awsEntry = log.find((e) => e.field === "aws.*");
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
