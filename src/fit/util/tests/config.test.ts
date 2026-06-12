import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_CAPELLA_SETTINGS,
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

test("parses stored results-database credentials under output", () => {
  const parsed = parseFitCliConfig(`{ version: 1, output: { resultsDb: { password: 's3cret', username: 'readonly' } } }`);

  assert.deepEqual(parsed, {
    version: FIT_CLI_CONFIG_VERSION,
    output: { resultsDb: { password: "s3cret", username: "readonly" } },
  });
});

test("folds a legacy top-level resultsDb into output.resultsDb", () => {
  const parsed = parseFitCliConfig(`{ version: 1, resultsDb: { password: 's3cret', username: 'readonly' } }`);

  assert.deepEqual(parsed, {
    version: FIT_CLI_CONFIG_VERSION,
    output: { resultsDb: { password: "s3cret", username: "readonly" } },
  });
});

test("parses the default output format", () => {
  const parsed = parseFitCliConfig(`{ version: 1, output: { format: 'yaml' } }`);
  assert.deepEqual(parsed, { version: FIT_CLI_CONFIG_VERSION, output: { format: "yaml" } });
});

test("rejects an invalid output format", () => {
  assert.throws(() => parseFitCliConfig(`{ version: 1, output: { format: 'toml' } }`), /output\.format/);
});

test("resolveResultsDbCredentials prefers config over the environment", () => {
  const credentials = resolveResultsDbCredentials({
    config: { version: FIT_CLI_CONFIG_VERSION, output: { resultsDb: { password: "from-config" } } },
    env: { FIT_RESULTS_DB_PASSWORD: "from-env", FIT_RESULTS_DB_USERNAME: "env-user" },
  });
  assert.deepEqual(credentials, { password: "from-config", username: "env-user" });
});

test("resolveResultsDbCredentials falls back to FIT_RESULTS_DB_* env vars", () => {
  assert.deepEqual(
    resolveResultsDbCredentials({
      config: { version: FIT_CLI_CONFIG_VERSION },
      env: { FIT_RESULTS_DB_PASSWORD: "env-pass" },
    }),
    { password: "env-pass", username: undefined },
  );
});

test("parses a stored capella section", () => {
  const parsed = parseFitCliConfig(`{
  version: 1,
  capella: { username: "graham.pople@couchbase.com", organizationId: "org-123" },
}`);
  assert.deepEqual(parsed.capella, { username: "graham.pople@couchbase.com", organizationId: "org-123" });
});

test("resolveCapellaConfig fills every field but username from defaults", () => {
  const resolved = resolveCapellaConfig({
    config: { version: FIT_CLI_CONFIG_VERSION, capella: { username: "me@cb.com" } },
    env: {},
  });
  assert.deepEqual(resolved, {
    username: "me@cb.com",
    endpoint: DEFAULT_CAPELLA_SETTINGS.endpoint,
    organizationId: DEFAULT_CAPELLA_SETTINGS.organizationId,
    password: DEFAULT_CAPELLA_SETTINGS.password,
  });
});

test("resolveCapellaConfig prefers config, then CAPELLA_*/CAP_* env, then default", () => {
  const fromConfig = resolveCapellaConfig({
    config: { version: FIT_CLI_CONFIG_VERSION, capella: { username: "cfg", endpoint: "https://cfg" } },
    env: { CAPELLA_ENDPOINT: "https://env", CAPELLA_USER: "envuser" },
  });
  assert.equal(fromConfig.username, "cfg");
  assert.equal(fromConfig.endpoint, "https://cfg");

  const fromEnv = resolveCapellaConfig({
    config: { version: FIT_CLI_CONFIG_VERSION },
    env: { CAP_USER: "graham", CAP_OID: "org-from-cap" },
  });
  assert.equal(fromEnv.username, "graham");
  assert.equal(fromEnv.organizationId, "org-from-cap");
  assert.equal(fromEnv.endpoint, DEFAULT_CAPELLA_SETTINGS.endpoint);
});

test("resolveCapellaConfig leaves username undefined when nothing provides one", () => {
  const resolved = resolveCapellaConfig({ config: { version: FIT_CLI_CONFIG_VERSION }, env: {} });
  assert.equal(resolved.username, undefined);
  assert.equal(resolved.endpoint, DEFAULT_CAPELLA_SETTINGS.endpoint);
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
