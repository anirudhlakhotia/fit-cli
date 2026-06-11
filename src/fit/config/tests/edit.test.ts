import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CLOUD_INSTANCE_TYPES, FIT_CLI_CONFIG_VERSION, type FitCliConfig } from "../../util/config.js";
import { initAnswersToConfig, initDefaultsFromConfig, initDefaultsFromEnv } from "../edit.js";

const ALL_TYPES = { functional: "c5.xlarge", situational: "c5.xlarge", perf: "c5.4xlarge" } as const;

test("init defaults reuse saved cloud settings, filling gaps with baked defaults", () => {
  const config: FitCliConfig = {
    version: FIT_CLI_CONFIG_VERSION,
    cloud: {
      aws: {
        region: "eu-west-1",
        profile: "dev",
        instanceTypes: { perf: "m6i.large" },
      },
    },
  };

  assert.deepEqual(initDefaultsFromConfig(config), {
    region: "eu-west-1",
    profile: "dev",
    instanceTypes: {
      functional: DEFAULT_CLOUD_INSTANCE_TYPES.aws.functional,
      situational: DEFAULT_CLOUD_INSTANCE_TYPES.aws.situational,
      perf: "m6i.large",
    },
  });
});

test("init defaults can seed from environment values", () => {
  assert.deepEqual(
    initDefaultsFromEnv({
      AWS_REGION: "us-east-2",
      AWS_PROFILE: "dev",
      // A single FIT_EC2_INSTANCE_TYPE seeds every purpose that has no specific override.
      FIT_EC2_INSTANCE_TYPE: "c6i.large",
      FIT_EC2_INSTANCE_TYPE_PERF: "c6i.4xlarge",
    }),
    {
      region: "us-east-2",
      profile: "dev",
      instanceTypes: {
        functional: "c6i.large",
        situational: "c6i.large",
        perf: "c6i.4xlarge",
      },
    },
  );
});

test("init answers keep non-secret cloud settings", () => {
  const config = initAnswersToConfig({
    configureAws: true,
    aws: { region: "us-east-1", profile: "", instanceTypes: { ...ALL_TYPES } },
  });

  assert.deepEqual(config, {
    version: FIT_CLI_CONFIG_VERSION,
    cloud: { aws: { region: "us-east-1", instanceTypes: { ...ALL_TYPES } } },
  });
});

test("init answers drop legacy stored credentials", () => {
  const config = initAnswersToConfig({
    configureAws: true,
    aws: { region: "us-east-1", profile: "dev", instanceTypes: { ...ALL_TYPES } },
  });

  assert.deepEqual(config, {
    version: FIT_CLI_CONFIG_VERSION,
    cloud: { aws: { region: "us-east-1", profile: "dev", instanceTypes: { ...ALL_TYPES } } },
  });
});

test("init answers can skip AWS entirely", () => {
  const config = initAnswersToConfig({ configureAws: false });

  assert.deepEqual(config, { version: FIT_CLI_CONFIG_VERSION });
});

test("init answers keep existing cloud settings when AWS is declined", () => {
  const existing: FitCliConfig = {
    version: FIT_CLI_CONFIG_VERSION,
    cloud: { aws: { region: "eu-west-2", profile: "dev", instanceTypes: { perf: "m6i.large" } } },
  };

  const config = initAnswersToConfig({ configureAws: false, githubToken: "ghp_new" }, existing);

  assert.deepEqual(config, {
    version: FIT_CLI_CONFIG_VERSION,
    cloud: { aws: { region: "eu-west-2", profile: "dev", instanceTypes: { perf: "m6i.large" } } },
    github: { token: "ghp_new" },
  });
});

test("init answers store a GitHub token alongside (or without) AWS", () => {
  assert.deepEqual(initAnswersToConfig({ configureAws: false, githubToken: "ghp_example" }), {
    version: FIT_CLI_CONFIG_VERSION,
    github: { token: "ghp_example" },
  });

  assert.deepEqual(
    initAnswersToConfig({
      configureAws: true,
      githubToken: "  ghp_trimmed  ",
      aws: { region: "us-east-1", profile: "", instanceTypes: { ...ALL_TYPES } },
    }),
    {
      version: FIT_CLI_CONFIG_VERSION,
      cloud: { aws: { region: "us-east-1", instanceTypes: { ...ALL_TYPES } } },
      github: { token: "ghp_trimmed" },
    },
  );
});
