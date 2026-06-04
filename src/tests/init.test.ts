import assert from "node:assert/strict";
import { test } from "node:test";
import { FIT_CLI_CONFIG_VERSION, type FitCliConfig } from "../util/fit/config.js";
import { initAnswersToConfig, initDefaultsFromConfig, initDefaultsFromEnv } from "../init.js";

test("init defaults reuse saved AWS settings", () => {
  const config: FitCliConfig = {
    version: FIT_CLI_CONFIG_VERSION,
    aws: {
      region: "eu-west-1",
      profile: "dev",
      instanceType: "m6i.large",
    },
  };

  assert.deepEqual(initDefaultsFromConfig(config), {
    region: "eu-west-1",
    profile: "dev",
    instanceType: "m6i.large",
  });
});

test("init defaults can seed from environment values", () => {
  assert.deepEqual(
    initDefaultsFromEnv({
      AWS_REGION: "us-east-2",
      AWS_PROFILE: "dev",
      FIT_EC2_INSTANCE_TYPE: "c6i.large",
    }),
    {
      region: "us-east-2",
      profile: "dev",
      instanceType: "c6i.large",
    },
  );
});

test("init answers keep non-secret AWS settings", () => {
  const config = initAnswersToConfig(
    {
      configureAws: true,
      aws: {
        region: "us-east-1",
        profile: "",
        instanceType: "c5.xlarge",
      },
    },
  );

  assert.deepEqual(config, {
    version: FIT_CLI_CONFIG_VERSION,
    aws: {
      region: "us-east-1",
      instanceType: "c5.xlarge",
    },
  });
});

test("init answers drop legacy stored credentials", () => {
  const config = initAnswersToConfig(
    {
      configureAws: true,
      aws: {
        region: "us-east-1",
        profile: "dev",
        instanceType: "c5.xlarge",
      },
    },
  );

  assert.deepEqual(config, {
    version: FIT_CLI_CONFIG_VERSION,
    aws: {
      region: "us-east-1",
      profile: "dev",
      instanceType: "c5.xlarge",
    },
  });
});

test("init answers can skip AWS entirely", () => {
  const config = initAnswersToConfig({
    configureAws: false,
  });

  assert.deepEqual(config, {
    version: FIT_CLI_CONFIG_VERSION,
  });
});
