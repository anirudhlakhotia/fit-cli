import assert from "node:assert/strict";
import test from "node:test";
import { sdkByValue } from "../../../util/sdk/sdks.js";
import {
  createLocalFitExecutionContext,
  gitCredentialsLine,
  remoteBuildWorkspaceRepos,
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

test("remoteFitRepos includes the JVM workspace repo when needed", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.deepEqual(
    remoteFitRepos(sdk).map((repo) => repo.dir),
    ["transactions-fit-performer", "jenkins-sdk", "couchbase-jvm-clients"],
  );
});

test("remoteFitRepos skips couchbase-jvm-clients for non-JVM SDKs", () => {
  const sdk = sdkByValue("go");
  assert.ok(sdk);
  assert.deepEqual(
    remoteFitRepos(sdk).map((repo) => repo.dir),
    ["transactions-fit-performer", "jenkins-sdk"],
  );
});

test("remoteWorkspaceRepos only includes repos needed before a build", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.deepEqual(
    remoteWorkspaceRepos(sdk).map((repo) => repo.dir),
    ["transactions-fit-performer", "couchbase-jvm-clients"],
  );
});

test("remoteBuildWorkspaceRepos includes jenkins-sdk for performer builds", () => {
  const sdk = sdkByValue("go");
  assert.ok(sdk);
  assert.deepEqual(
    remoteBuildWorkspaceRepos(sdk).map((repo) => repo.dir),
    ["transactions-fit-performer", "jenkins-sdk"],
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

test("redirectShellCommand appends stdout and stderr redirection to a shell command", () => {
  assert.equal(
    redirectShellCommand("export PATH=/tmp/bin:$PATH; ./mvnw test", "/tmp/fit logs/driver.log"),
    "export PATH=/tmp/bin:$PATH; ./mvnw test > '/tmp/fit logs/driver.log' 2>&1",
  );
});
