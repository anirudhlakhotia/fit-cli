import assert from "node:assert/strict";
import test from "node:test";
import type { ClusterCommandExecutor } from "../allocate-cluster.js";
import { cbdinoclusterNeedsInit, dockerNetworkFromInitArgs, setupDeclarativeCluster } from "../setup-declarative-cluster.js";

const CLUSTER_PS_OUTPUT = `2026-06-03T13:02:18.157+0100    INFO    logger initialized
Clusters:
  df45d6d0-cfbe-4905-bc8c-989a09c03817 [Type: server, State: ready, Timeout: none, Deployer: docker]
    4e9e2165-6fb6-4114-bf44-aba0ed02a25e                          172.18.0.2           f58b3be1...
`;

function executor(): ClusterCommandExecutor & {
  kind: "remote";
  runCalls: Array<{ command: string; args: string[] }>;
  stagedFiles: Array<{ localPath: string; targetPath: string }>;
} {
  const runCalls: Array<{ command: string; args: string[] }> = [];
  const stagedFiles: Array<{ localPath: string; targetPath: string }> = [];
  let psCalls = 0;

  return {
    kind: "remote",
    description: "remote host",
    runCalls,
    stagedFiles,
    run: (command, args) => {
      runCalls.push({ command, args });
      return Promise.resolve();
    },
    capture: (_command, args) => {
      if (args[0] === "ps") {
        psCalls += 1;
        if (psCalls === 1 && stagedFiles.length === 0) {
          return Promise.reject(new Error("cbdinocluster exited with code 1: FATAL you must run the `init` command first"));
        }
        return Promise.resolve(CLUSTER_PS_OUTPUT);
      }
      if (args[0] === "connstr") {
        return Promise.resolve("couchbase://172.18.0.2\n");
      }
      return Promise.resolve("");
    },
    runToFile: () => Promise.resolve(),
    targetFilePath: (path) => path,
    stageFile: (localPath, targetPath = localPath) => {
      stagedFiles.push({ localPath, targetPath });
      return Promise.resolve(targetPath);
    },
    collectFile: () => Promise.resolve(),
    commandAvailable: () => Promise.resolve(true),
  };
}

test("cbdinoclusterNeedsInit spots the init-required failure", () => {
  assert.equal(cbdinoclusterNeedsInit("FATAL you must run the `init` command first"), true);
  assert.equal(cbdinoclusterNeedsInit("permission denied"), false);
});

test("dockerNetworkFromInitArgs reads --docker-network in both forms", () => {
  assert.equal(dockerNetworkFromInitArgs("--auto --disable-k8s --docker-network fit"), "fit");
  assert.equal(dockerNetworkFromInitArgs("--docker-network=mynet --auto"), "mynet");
  assert.equal(dockerNetworkFromInitArgs("--auto --disable-k8s"), undefined);
});

/** A remote executor that only succeeds at `ps` once `cbdinocluster init` has run. */
function initAwareExecutor(): ClusterCommandExecutor & {
  kind: "remote";
  runCalls: Array<{ command: string; args: string[] }>;
  stagedFiles: Array<{ localPath: string; targetPath: string }>;
} {
  const runCalls: Array<{ command: string; args: string[] }> = [];
  const stagedFiles: Array<{ localPath: string; targetPath: string }> = [];
  let inited = false;
  return {
    kind: "remote",
    description: "remote host",
    runCalls,
    stagedFiles,
    run: (command, args) => {
      runCalls.push({ command, args });
      if (command === "cbdinocluster" && args[0] === "init") {
        inited = true;
      }
      return Promise.resolve();
    },
    capture: (_command, args) => {
      if (args[0] === "ps") {
        return inited
          ? Promise.resolve(CLUSTER_PS_OUTPUT)
          : Promise.reject(new Error("cbdinocluster exited with code 1: FATAL you must run the `init` command first"));
      }
      if (args[0] === "connstr") {
        return Promise.resolve("couchbase://172.18.0.2\n");
      }
      return Promise.resolve("");
    },
    runToFile: () => Promise.resolve(),
    targetFilePath: (path) => path,
    stageFile: (localPath, targetPath = localPath) => {
      stagedFiles.push({ localPath, targetPath });
      return Promise.resolve(targetPath);
    },
    collectFile: () => Promise.resolve(),
    commandAvailable: () => Promise.resolve(true),
  };
}

test("setupDeclarativeCluster runs `cbdinocluster init` for the docker args path", async () => {
  const execution = initAwareExecutor();

  const result = await setupDeclarativeCluster(
    {
      init: { args: "--auto --disable-k8s --docker-network fit" },
      config: { nodes: [{ count: 1, version: "8.1.0", services: ["kv"] }] },
      onClusterExists: "useExisting",
      githubCredentials: { user: "alice", token: "ghtoken" },
    },
    execution,
  );

  const initCall = execution.runCalls.find((c) => c.command === "cbdinocluster" && c.args[0] === "init");
  assert.ok(initCall, "expected a `cbdinocluster init` call");
  // The editable args are passed through and the GitHub credentials are appended.
  assert.deepEqual(initCall.args, [
    "init", "--auto", "--disable-k8s", "--docker-network", "fit",
    "--github-user", "alice", "--github-token", "ghtoken",
  ]);
  // The docker network the args name is created, and no config file is uploaded.
  assert.ok(execution.runCalls.some((c) => c.command === "docker" && c.args.join(" ") === "network create fit"));
  assert.equal(execution.stagedFiles.length, 0);
  assert.equal(result.cluster?.defaultHostname, "172.18.0.2");
});

test("setupDeclarativeCluster falls back to --disable-github when no credentials are given", async () => {
  const execution = initAwareExecutor();
  await setupDeclarativeCluster(
    {
      init: { args: "--auto --docker-network fit" },
      config: { nodes: [{ count: 1, version: "8.1.0", services: ["kv"] }] },
      onClusterExists: "useExisting",
    },
    execution,
  );
  const initCall = execution.runCalls.find((c) => c.command === "cbdinocluster" && c.args[0] === "init");
  assert.deepEqual(initCall?.args, ["init", "--auto", "--docker-network", "fit", "--disable-github"]);
});

test("setupDeclarativeCluster initializes cbdinocluster before retrying ps", async () => {
  const execution = executor();

  const result = await setupDeclarativeCluster(
    {
      init: {
        config: {
          version: 6,
          docker: { enabled: "true", network: "fit" },
        },
      },
      config: { nodes: [{ count: 1, version: "8.1.0", services: ["kv"] }] },
      onClusterExists: "useExisting",
    },
    execution,
  );

  assert.equal(execution.stagedFiles.length, 1);
  assert.match(execution.stagedFiles[0].localPath, /cbdinocluster-init\.yaml$/);
  assert.deepEqual(execution.runCalls, [
    {
      command: "sh",
      args: ["-lc", `cp ${execution.stagedFiles[0].targetPath} ~/.cbdinocluster && chmod 600 ~/.cbdinocluster`],
    },
    {
      command: "docker",
      args: ["network", "create", "fit"],
    },
  ]);
  assert.equal(result.allocated, false);
  assert.equal(result.cluster?.defaultHostname, "172.18.0.2");
});
