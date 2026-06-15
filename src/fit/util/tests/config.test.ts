import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_CLOUD_INSTANCE_TYPES,
  FIT_CLI_CONFIG_VERSION,
  UnsupportedFitCliConfigVersionError,
  applyFitCliConfigToEnv,
  ensureFitCliConfigEnv,
  loadFitCliConfig,
  parseFitCliConfig,
  resolveCapellaConfig,
  resolveCloudInstanceType,
  resolveGithubToken,
  resolveResultsDbCredentials,
  saveFitCliConfig,
  type FitCliConfig,
} from "../config.js";

test("parses a version 1 fit-cli config (JSON5)", () => {
  const parsed = parseFitCliConfig(`{
  version: 1,
  cloud: {
    aws: {
      region: 'us-east-1',
      profile: 'dev',
      instanceTypes: {
        functional: 'c5.xlarge',
        situational: 'c5.2xlarge',
        perf: 'c5.4xlarge',
      },
    },
  },
}`);

  assert.deepEqual(parsed, {
    version: FIT_CLI_CONFIG_VERSION,
    cloud: {
      aws: {
        profile: "dev",
        instanceTypes: {
          functional: "c5.xlarge",
          situational: "c5.2xlarge",
          perf: "c5.4xlarge",
        },
      },
    },
  });
});

test("parses a version 1 fit-cli config (YAML, backward compat)", () => {
  const parsed = parseFitCliConfig(
    `version: 1\ncloud:\n  aws:\n    region: us-east-1\n    profile: dev\n    instanceTypes:\n      perf: c5.4xlarge\n`,
    "yaml",
  );

  // A legacy `region` key is silently ignored — region is now fixed, not configurable.
  assert.deepEqual(parsed, {
    version: FIT_CLI_CONFIG_VERSION,
    cloud: {
      aws: {
        profile: "dev",
        instanceTypes: { perf: "c5.4xlarge" },
      },
    },
  });
});

test("ignores legacy stored AWS credentials and region in config", () => {
  const parsed = parseFitCliConfig(`{
  version: 1,
  cloud: {
    aws: {
      accessKeyId: 'abc',
      secretAccessKey: 'def',
      region: 'us-east-1',
      profile: 'dev',
    },
  },
}`);

  assert.deepEqual(parsed, {
    version: FIT_CLI_CONFIG_VERSION,
    cloud: {
      aws: {
        profile: "dev",
      },
    },
  });
});

test("parses a stored GitHub token", () => {
  const parsed = parseFitCliConfig(`{ version: 1, github: { token: 'ghp_example' } }`);

  assert.deepEqual(parsed, {
    version: FIT_CLI_CONFIG_VERSION,
    github: { token: "ghp_example" },
  });
});

test("resolveGithubToken prefers the config token over the environment", () => {
  const token = resolveGithubToken({
    config: { version: FIT_CLI_CONFIG_VERSION, github: { token: "from-config" } },
    env: { GITHUB_TOKEN: "from-env" },
  });
  assert.equal(token, "from-config");
});

test("resolveGithubToken falls back to GITHUB_TOKEN then GH_TOKEN", () => {
  assert.equal(
    resolveGithubToken({ config: { version: FIT_CLI_CONFIG_VERSION }, env: { GITHUB_TOKEN: "gh-token" } }),
    "gh-token",
  );
  assert.equal(
    resolveGithubToken({ config: { version: FIT_CLI_CONFIG_VERSION }, env: { GH_TOKEN: "fallback" } }),
    "fallback",
  );
  assert.equal(resolveGithubToken({ config: { version: FIT_CLI_CONFIG_VERSION }, env: {} }), undefined);
});

const TEST_ENVIRONMENTS = {
  capella: { dev: { endpoint: "https://dev.example", oid: "oid-dev", secretId: "cap/dev" } },
  results: { dev: { host: "dev.db.example", secretId: "res/dev" } },
};
const noFetch = (): Promise<Record<string, string>> => Promise.reject(new Error("should not fetch the AWS secret"));

test("ignores results-database credentials in config (now resolved from AWS Secrets Manager)", () => {
  assert.deepEqual(parseFitCliConfig(`{ version: 1, output: { resultsDb: { password: 's' } } }`), {
    version: FIT_CLI_CONFIG_VERSION,
  });
  assert.deepEqual(parseFitCliConfig(`{ version: 1, resultsDb: { password: 's' } }`), {
    version: FIT_CLI_CONFIG_VERSION,
  });
});

test("parses the default output format", () => {
  const parsed = parseFitCliConfig(`{ version: 1, output: { format: 'yaml' } }`);
  assert.deepEqual(parsed, { version: FIT_CLI_CONFIG_VERSION, output: { format: "yaml" } });
});

test("rejects an invalid output format", () => {
  assert.throws(() => parseFitCliConfig(`{ version: 1, output: { format: 'toml' } }`), /output\.format/);
});

test("resolveResultsDbCredentials takes the host from the registry and the password from the secret", async () => {
  const creds = await resolveResultsDbCredentials({
    block: "dev",
    environments: TEST_ENVIRONMENTS,
    fetchSecret: () => Promise.resolve({ password: "s3cret" }),
  });
  assert.deepEqual(creds, { host: "dev.db.example", username: "postgres", password: "s3cret" });
});

test("resolveResultsDbCredentials uses the secret's username when present", async () => {
  const creds = await resolveResultsDbCredentials({
    block: "dev",
    environments: TEST_ENVIRONMENTS,
    fetchSecret: () => Promise.resolve({ password: "p", username: "readonly" }),
  });
  assert.equal(creds.username, "readonly");
});

test("resolveResultsDbCredentials rejects an unknown results environment", async () => {
  await assert.rejects(
    resolveResultsDbCredentials({ block: "nope", environments: TEST_ENVIRONMENTS, fetchSecret: noFetch }),
    /Unknown results environment "nope"/,
  );
});

test("parses a stored capella section (personal credentials only)", () => {
  const parsed = parseFitCliConfig(`{ version: 1, capella: { username: "graham.pople@couchbase.com", password: "pw" } }`);
  assert.deepEqual(parsed.capella, { username: "graham.pople@couchbase.com", password: "pw" });
});

test("resolveCapellaConfig prefers personal config credentials, with registry endpoint/oid", async () => {
  const resolved = await resolveCapellaConfig({
    block: "dev",
    environments: TEST_ENVIRONMENTS,
    config: { version: FIT_CLI_CONFIG_VERSION, capella: { username: "me@cb.com", password: "pw" } },
    env: {},
    fetchSecret: noFetch,
  });
  assert.deepEqual(resolved, {
    username: "me@cb.com",
    password: "pw",
    endpoint: "https://dev.example",
    organizationId: "oid-dev",
  });
});

test("resolveCapellaConfig prefers CAPELLA_*/CAP_* env over the shared account", async () => {
  const resolved = await resolveCapellaConfig({
    block: "dev",
    environments: TEST_ENVIRONMENTS,
    config: { version: FIT_CLI_CONFIG_VERSION },
    env: { CAPELLA_USER: "envuser", CAPELLA_PASS: "envpass" },
    fetchSecret: noFetch,
  });
  assert.equal(resolved.username, "envuser");
  assert.equal(resolved.password, "envpass");
  assert.equal(resolved.endpoint, "https://dev.example");
});

test("resolveCapellaConfig falls back to the shared AWS service account when no personal creds", async () => {
  const resolved = await resolveCapellaConfig({
    block: "dev",
    environments: TEST_ENVIRONMENTS,
    config: { version: FIT_CLI_CONFIG_VERSION },
    env: {},
    fetchSecret: () => Promise.resolve({ username: "svc-account", password: "svc-pw" }),
  });
  assert.equal(resolved.username, "svc-account");
  assert.equal(resolved.password, "svc-pw");
});

test("resolveCapellaConfig throws for an unprovisioned environment", async () => {
  await assert.rejects(
    resolveCapellaConfig({
      block: "stage",
      environments: { capella: { stage: { endpoint: null, oid: null, secretId: "cap/stage" } }, results: {} },
      config: { version: FIT_CLI_CONFIG_VERSION },
      env: {},
      fetchSecret: noFetch,
    }),
    /isn't fully provisioned/,
  );
});

test("rejects unsupported newer config versions", () => {
  assert.throws(
    () => parseFitCliConfig("{ version: 2 }"),
    UnsupportedFitCliConfigVersionError,
  );
});

test("applies config values only when the environment is unset", () => {
  const env: NodeJS.ProcessEnv = { AWS_PROFILE: "from-env" };
  const applied = applyFitCliConfigToEnv(
    {
      version: FIT_CLI_CONFIG_VERSION,
      cloud: {
        aws: {
          profile: "dev",
          // Per-purpose instance types are not exported to the environment.
          instanceTypes: { functional: "c5.xlarge" },
        },
      },
    },
    env,
  );

  // AWS_PROFILE is already set in the environment, so config must not override it.
  assert.deepEqual(applied, []);
  assert.deepEqual(env, { AWS_PROFILE: "from-env" });
});

test("applies config values when the environment is unset", () => {
  const env: NodeJS.ProcessEnv = {};
  const applied = applyFitCliConfigToEnv(
    {
      version: FIT_CLI_CONFIG_VERSION,
      cloud: { aws: { profile: "dev", instanceTypes: { functional: "c5.xlarge" } } },
    },
    env,
  );

  assert.deepEqual(applied, ["AWS_PROFILE"]);
  assert.deepEqual(env, { AWS_PROFILE: "dev" });
});

test("resolveCloudInstanceType prefers config, then the baked default", () => {
  const config: FitCliConfig = {
    version: FIT_CLI_CONFIG_VERSION,
    cloud: { aws: { instanceTypes: { perf: "m6i.8xlarge" } } },
  };
  assert.equal(resolveCloudInstanceType("perf", { config }), "m6i.8xlarge");
  // functional not set in config → baked default.
  assert.equal(resolveCloudInstanceType("functional", { config }), DEFAULT_CLOUD_INSTANCE_TYPES.aws.functional);
  // no config at all → baked default.
  assert.equal(
    resolveCloudInstanceType("situational", { config: { version: FIT_CLI_CONFIG_VERSION } }),
    DEFAULT_CLOUD_INSTANCE_TYPES.aws.situational,
  );
});

test("saves and reloads config.json5", () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-config-"));
  const path = join(dir, "config.json5");
  saveFitCliConfig(
    {
      version: FIT_CLI_CONFIG_VERSION,
      cloud: {
        aws: {
          instanceTypes: { functional: "c5.xlarge", perf: "c5.4xlarge" },
        },
      },
    },
    path,
  );

  assert.match(readFileSync(path, "utf8"), /version: 1/);
  assert.deepEqual(loadFitCliConfig(path), {
    loaded: true,
    path,
    config: {
      version: FIT_CLI_CONFIG_VERSION,
      cloud: {
        aws: {
          instanceTypes: { functional: "c5.xlarge", perf: "c5.4xlarge" },
        },
      },
    },
  });
});

test("saves and reloads config.yaml (YAML format, backward compat)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-config-"));
  const path = join(dir, "config.yaml");
  saveFitCliConfig(
    {
      version: FIT_CLI_CONFIG_VERSION,
      cloud: {
        aws: {
          instanceTypes: { functional: "c5.xlarge" },
        },
      },
    },
    path,
  );

  assert.match(readFileSync(path, "utf8"), /version: 1/);
  assert.deepEqual(loadFitCliConfig(path), {
    loaded: true,
    path,
    config: {
      version: FIT_CLI_CONFIG_VERSION,
      cloud: {
        aws: {
          instanceTypes: { functional: "c5.xlarge" },
        },
      },
    },
  });
});

test("ensureFitCliConfigEnv can run init and apply the created config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-config-"));
  const path = join(dir, "config.json5");
  const env: NodeJS.ProcessEnv = {};
  const result = await ensureFitCliConfigEnv({
    path,
    env,
    confirmCreate: () => Promise.resolve(true),
    runInitWorkflow: (configPath) => {
      saveFitCliConfig(
        {
          version: FIT_CLI_CONFIG_VERSION,
          cloud: {
            aws: {
              profile: "dev",
            },
          },
        },
        configPath,
      );
      return Promise.resolve();
    },
  });

  assert.equal(result.loaded, true);
  assert.equal(result.created, true);
  assert.deepEqual(result.applied, ["AWS_PROFILE"]);
  assert.equal(env.AWS_PROFILE, "dev");
});

test("ensureFitCliConfigEnv returns without creating when the user declines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-config-"));
  const path = join(dir, "config.json5");
  const result = await ensureFitCliConfigEnv({
    path,
    confirmCreate: () => Promise.resolve(false),
  });

  assert.equal(result.loaded, false);
  assert.equal(result.created, false);
});
