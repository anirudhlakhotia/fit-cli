import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FIT_CLI_CONFIG_VERSION,
  UnsupportedFitCliConfigVersionError,
  applyFitCliConfigToEnv,
  ensureFitCliConfigEnv,
  loadFitCliConfig,
  parseFitCliConfig,
  saveFitCliConfig,
} from "../config.js";

test("parses a version 1 fit-cli config", () => {
  const parsed = parseFitCliConfig(`
version: 1
aws:
  accessKeyId: abc
  secretAccessKey: def
  region: us-east-1
  profile: dev
  instanceType: c5.xlarge
`);

  assert.deepEqual(parsed, {
    version: FIT_CLI_CONFIG_VERSION,
    aws: {
      accessKeyId: "abc",
      secretAccessKey: "def",
      region: "us-east-1",
      profile: "dev",
      instanceType: "c5.xlarge",
    },
  });
});

test("rejects unsupported newer config versions", () => {
  assert.throws(
    () => parseFitCliConfig("version: 2\n"),
    UnsupportedFitCliConfigVersionError,
  );
});

test("applies config values only when the environment is unset", () => {
  const env: NodeJS.ProcessEnv = { AWS_REGION: "eu-west-1" };
  const applied = applyFitCliConfigToEnv(
    {
      version: FIT_CLI_CONFIG_VERSION,
      aws: {
        accessKeyId: "abc",
        secretAccessKey: "",
        region: "us-east-1",
        profile: "dev",
        instanceType: "c5.xlarge",
      },
    },
    env,
  );

  assert.deepEqual(applied, ["AWS_ACCESS_KEY_ID", "AWS_PROFILE", "FIT_EC2_INSTANCE_TYPE"]);
  assert.deepEqual(env, {
    AWS_ACCESS_KEY_ID: "abc",
    AWS_REGION: "eu-west-1",
    AWS_PROFILE: "dev",
    FIT_EC2_INSTANCE_TYPE: "c5.xlarge",
  });
});

test("saves and reloads config.yaml", () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-config-"));
  const path = join(dir, "config.yaml");
  saveFitCliConfig(
    {
      version: FIT_CLI_CONFIG_VERSION,
      aws: {
        region: "us-east-1",
        instanceType: "c5.xlarge",
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
      aws: {
        region: "us-east-1",
        instanceType: "c5.xlarge",
      },
    },
  });
});

test("ensureFitCliConfigEnv can run init and apply the created config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-config-"));
  const path = join(dir, "config.yaml");
  const env: NodeJS.ProcessEnv = {};
  const result = await ensureFitCliConfigEnv({
    path,
    env,
    confirmCreate: () => Promise.resolve(true),
    runInitWorkflow: (configPath) => {
      saveFitCliConfig(
        {
          version: FIT_CLI_CONFIG_VERSION,
          aws: {
            accessKeyId: "abc",
            region: "us-east-1",
          },
        },
        configPath,
      );
      return Promise.resolve();
    },
  });

  assert.equal(result.loaded, true);
  assert.equal(result.created, true);
  assert.deepEqual(result.applied, ["AWS_ACCESS_KEY_ID", "AWS_REGION"]);
  assert.equal(env.AWS_ACCESS_KEY_ID, "abc");
  assert.equal(env.AWS_REGION, "us-east-1");
});

test("ensureFitCliConfigEnv returns without creating when the user declines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-config-"));
  const path = join(dir, "config.yaml");
  const result = await ensureFitCliConfigEnv({
    path,
    confirmCreate: () => Promise.resolve(false),
  });

  assert.equal(result.loaded, false);
  assert.equal(result.created, false);
});
