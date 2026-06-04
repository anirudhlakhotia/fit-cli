import assert from "node:assert/strict";
import { test } from "node:test";
import { FIT_CLI_CONFIG_VERSION, type FitCliConfig } from "../util/non-fit/config.js";
import { initAnswersToConfig, initDefaultsFromConfig, initDefaultsFromEnv } from "../init.js";

test("init defaults reuse non-secret config values and blank the secret", () => {
  const config: FitCliConfig = {
    version: FIT_CLI_CONFIG_VERSION,
    aws: {
      accessKeyId: "abc",
      secretAccessKey: "def",
      region: "eu-west-1",
      profile: "dev",
      instanceType: "m6i.large",
    },
  };

  assert.deepEqual(initDefaultsFromConfig(config), {
    accessKeyId: "abc",
    secretAccessKey: "",
    region: "eu-west-1",
    profile: "dev",
    instanceType: "m6i.large",
  });
});

test("init defaults can seed from environment values", () => {
  assert.deepEqual(
    initDefaultsFromEnv({
      AWS_ACCESS_KEY_ID: "abc",
      AWS_SECRET_ACCESS_KEY: "def",
      AWS_REGION: "us-east-2",
      AWS_PROFILE: "dev",
      FIT_EC2_INSTANCE_TYPE: "c6i.large",
    }),
    {
      accessKeyId: "abc",
      secretAccessKey: "",
      region: "us-east-2",
      profile: "dev",
      instanceType: "c6i.large",
    },
  );
});

test("blank secret answers preserve an existing saved secret when access key id remains set", () => {
  const config = initAnswersToConfig(
    {
      accessKeyId: "abc",
      secretAccessKey: "",
      region: "us-east-1",
      profile: "",
      instanceType: "c5.xlarge",
    },
    {
      version: FIT_CLI_CONFIG_VERSION,
      aws: {
        accessKeyId: "abc",
        secretAccessKey: "def",
      },
    },
  );

  assert.deepEqual(config, {
    version: FIT_CLI_CONFIG_VERSION,
    aws: {
      accessKeyId: "abc",
      secretAccessKey: "def",
      region: "us-east-1",
      instanceType: "c5.xlarge",
    },
  });
});

test("clearing the access key id also drops any saved secret", () => {
  const config = initAnswersToConfig(
    {
      accessKeyId: "",
      secretAccessKey: "",
      region: "us-east-1",
      profile: "dev",
      instanceType: "c5.xlarge",
    },
    {
      version: FIT_CLI_CONFIG_VERSION,
      aws: {
        accessKeyId: "abc",
        secretAccessKey: "def",
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
