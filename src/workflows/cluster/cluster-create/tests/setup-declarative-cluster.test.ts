import assert from "node:assert/strict";
import test from "node:test";
import type { ClusterCommandExecutor } from "../allocate-cluster.js";
import { cbdinoclusterNeedsInit, setupDeclarativeCluster } from "../setup-declarative-cluster.js";

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
      command: "sh",
      args: ["-lc", "docker network inspect fit >/dev/null 2>&1 || docker network create fit >/dev/null"],
    },
  ]);
  assert.equal(result.allocated, false);
  assert.equal(result.cluster?.defaultHostname, "172.18.0.2");
});
