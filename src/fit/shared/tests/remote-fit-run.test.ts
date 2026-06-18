import assert from "node:assert/strict";
import test from "node:test";
import { sdkByValue } from "../../../util/sdk/sdks.js";
import {
  createLocalFitExecutionContext,
  gitCredentialsLine,
  pathPrefixedCommand,
  redirectShellCommand,
  redirectToFileCommand,
  remoteDockerWrapperScript,
  remoteFitRepos,
  remoteFitRootDir,
  remoteWorkspaceRepos,
  remotePerformerArgs,
} from "../util/remote-fit-run.js";

test("remoteFitRootDir defaults to the ubuntu home directory", () => {
  assert.equal(remoteFitRootDir(), "/home/ubuntu/fit-workspace");
});

test("remoteFitRepos clones transactions-fit-performer and jenkins-sdk (the latter for the situational perf DB)", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.deepEqual(
    remoteFitRepos(sdk).map((repo) => repo.dir),
    ["transactions-fit-performer", "jenkins-sdk"],
  );
});

test("remoteWorkspaceRepos only includes transactions-fit-performer", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.deepEqual(
    remoteWorkspaceRepos(sdk).map((repo) => repo.dir),
    ["transactions-fit-performer"],
  );
});

test("remoteDockerWrapperScript routes docker through passwordless sudo", () => {
  assert.equal(remoteDockerWrapperScript(), "#!/bin/sh\nexec sudo -n /usr/bin/docker \"$@\"\n");
});

test("gitCredentialsLine grants github.com access via the x-access-token user", () => {
  assert.equal(gitCredentialsLine("ghp_secret"), "https://x-access-token:ghp_secret@github.com\n");
});

test("createLocalFitExecutionContext keeps local file paths unchanged", () => {
  const execution = createLocalFitExecutionContext("/work/root");
  assert.equal(execution.targetFilePath("/tmp/fit-cli/run/driver.log"), "/tmp/fit-cli/run/driver.log");
});

test("createLocalFitExecutionContext builds local docker run args without host-gateway wiring", () => {
  const execution = createLocalFitExecutionContext("/work/root");
  assert.deepEqual(execution.performerRunArgs("performer-node-main"), [
    "run",
    "--detach",
    "--rm",
    "--publish",
    "8060:8060",
    "--env",
    "LOG_LEVEL=debug",
    "performer-node-main",
  ]);
});

test("createLocalFitExecutionContext can attach the performer to a cluster Docker network", () => {
  const execution = createLocalFitExecutionContext("/work/root");
  assert.deepEqual(execution.performerRunArgs("performer-node-main", 8060, "fit-net"), [
    "run",
    "--detach",
    "--rm",
    "--network",
    "fit-net",
    "--publish",
    "8060:8060",
    "--env",
    "LOG_LEVEL=debug",
    "performer-node-main",
  ]);
});

test("remotePerformerArgs add the host-gateway alias and can join a Docker network", () => {
  assert.deepEqual(remotePerformerArgs("performer-node-main", 8060, "fit-net"), [
    "run",
    "--detach",
    "--rm",
    "--add-host",
    "host.docker.internal:host-gateway",
    "--network",
    "fit-net",
    "--publish",
    "8060:8060",
    "--env",
    "LOG_LEVEL=debug",
    "performer-node-main",
  ]);
});

test("pathPrefixedCommand exports PATH before running the command", () => {
  assert.equal(
    pathPrefixedCommand("/home/ubuntu/fit-workspace/bin", "./gradlew", ["buildPerformer"]),
    "export PATH=/home/ubuntu/fit-workspace/bin:$PATH; ./gradlew buildPerformer",
  );
});

test("redirectToFileCommand quotes shell-sensitive args and paths", () => {
  assert.equal(
    redirectToFileCommand("./mvnw", ["-Dtest=a b", "test"], "/tmp/fit logs/driver.log"),
    "./mvnw '-Dtest=a b' test > '/tmp/fit logs/driver.log' 2>&1",
  );
});

test("redirectShellCommand streams and saves output via tee with pipefail", () => {
  assert.equal(
    redirectShellCommand("export PATH=/tmp/bin:$PATH; ./mvnw test", "/tmp/fit logs/driver.log"),
    "set -o pipefail; export PATH=/tmp/bin:$PATH; ./mvnw test 2>&1 | tee '/tmp/fit logs/driver.log'",
  );
});
