import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ClusterCommandExecutor } from "../../cluster-create/allocate-cluster.js";
import { collectClusterLogs, collectLogsArgs } from "../cluster-cbcollect.js";

test("collectLogsArgs builds the cbdinocluster collect-logs invocation", () => {
  assert.deepEqual(collectLogsArgs("abc123", "/tmp/logs"), ["collect-logs", "abc123", "/tmp/logs"]);
});

/** A fake (remote-style) executor that records run/collect calls and lists two collected bundles. */
function collectExecutor(opts: { collectFails?: boolean } = {}): ClusterCommandExecutor & {
  runCalls: Array<{ command: string; args: string[] }>;
  collectedFiles: Array<{ targetPath: string; localPath: string }>;
} {
  const runCalls: Array<{ command: string; args: string[] }> = [];
  const collectedFiles: Array<{ targetPath: string; localPath: string }> = [];
  return {
    description: "remote host",
    runCalls,
    collectedFiles,
    run: (command, args) => {
      runCalls.push({ command, args });
      if (opts.collectFails && args[0] === "collect-logs") {
        return Promise.reject(new Error("cbdinocluster collect-logs failed"));
      }
      return Promise.resolve();
    },
    capture: (_command, args) =>
      args.includes("-1") ? Promise.resolve("node1.zip\nnode2.zip\n") : Promise.resolve(""),
    runToFile: () => Promise.resolve(),
    // Remote layout: cbdinocluster writes under <rootDir>/<basename>.
    targetFilePath: (path) => join("/remote/root", path.split("/").pop() ?? ""),
    stageFile: (localPath, targetPath = localPath) => Promise.resolve(targetPath),
    collectFile: (targetPath, localPath) => {
      collectedFiles.push({ targetPath, localPath });
      return Promise.resolve();
    },
    commandAvailable: () => Promise.resolve(true),
  };
}

test("collectClusterLogs collects each bundle into the local logs dir", async () => {
  const execution = collectExecutor();
  const logsDir = mkdtempSync(join(tmpdir(), "fit-cbcollect-"));
  try {
    const ok = await collectClusterLogs("cbdinocluster", "abc123", logsDir, execution);
    assert.equal(ok, true);

    // The target dir (on the box) is wiped and recreated, then collect-logs runs against it.
    const targetDir = join("/remote/root", logsDir.split("/").pop() ?? "");
    assert.deepEqual(execution.runCalls, [
      { command: "rm", args: ["-rf", targetDir] },
      { command: "mkdir", args: ["-p", targetDir] },
      { command: "cbdinocluster", args: ["collect-logs", "abc123", targetDir] },
    ]);
    // Each listed bundle is pulled back from the box into the local logs dir.
    assert.deepEqual(execution.collectedFiles, [
      { targetPath: join(targetDir, "node1.zip"), localPath: join(logsDir, "node1.zip") },
      { targetPath: join(targetDir, "node2.zip"), localPath: join(logsDir, "node2.zip") },
    ]);
  } finally {
    rmSync(logsDir, { recursive: true, force: true });
  }
});

test("collectClusterLogs is best effort — a collect failure resolves false without throwing", async () => {
  const execution = collectExecutor({ collectFails: true });
  const logsDir = mkdtempSync(join(tmpdir(), "fit-cbcollect-"));
  try {
    const ok = await collectClusterLogs("cbdinocluster", "abc123", logsDir, execution);
    assert.equal(ok, false);
    assert.equal(execution.collectedFiles.length, 0);
  } finally {
    rmSync(logsDir, { recursive: true, force: true });
  }
});
