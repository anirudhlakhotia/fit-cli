import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sdkByValue } from "../../../../util/sdk/sdks.js";
import type { ClusterCommandExecutor } from "../../../cluster/cluster-create/allocate-cluster.js";
import type {
  ResolvedFunctionalExecutionGroup,
  ResolvedSituationalExecutionRun,
} from "../../../fit-shared/definition/resolve-definition.js";
import type { FitExecutionContext } from "../../../fit-shared/util/remote-fit-run.js";
import {
  cbdinoclusterSetupFailed,
  finalizeRunFromDefinition,
  runSituationalTests,
  runTests,
  setupCluster,
} from "../run-from-definition.js";

function functionalCycle(): ResolvedFunctionalExecutionGroup {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  return {
    type: "functional",
    path: { instanceIndex: 0, clusterIndex: 0 },
    instance: { kind: "localhost" },
    clusterMode: "cbdinocluster",
    cng: false,
    cbdinocluster: {
      config: { nodes: [{ count: 1, version: "8.1.0-2188", services: ["kv"] }] },
      onClusterExists: "destroyAndRecreate",
    },
    runs: [
      {
        type: "functional",
        path: { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0, runIndex: 0 },
        sdk,
        performerPort: 8060,
        testSelection: { allTests: [], selectedTests: [] },
        onPortInUse: "restart",
        extraMavenArgs: [],
      },
      {
        type: "functional",
        path: { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0, runIndex: 1 },
        sdk,
        performerPort: 8061,
        testSelection: { allTests: [], selectedTests: [] },
        onPortInUse: "restart",
        extraMavenArgs: [],
      },
    ],
  };
}

function executor(): ClusterCommandExecutor {
  return {
    description: "test target",
    run: () => Promise.resolve(),
    capture: () => Promise.resolve(""),
    runToFile: () => Promise.resolve(),
    targetFilePath: (path) => path,
    stageFile: (path) => Promise.resolve(path),
    collectFile: () => Promise.resolve(),
    commandAvailable: () => Promise.resolve(true),
  };
}

function cluster() {
  return {
    scheme: "couchbase" as const,
    defaultHostname: "localhost",
    flavour: "self-managed" as const,
    credentials: { username: "Administrator", password: "password" },
    tls: null,
  };
}

function iteration() {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  return {
    type: "functional" as const,
    path: { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0, runIndex: 0 },
    sdk,
    cluster: cluster(),
    performerPort: 8060,
    testSelection: { allTests: [], selectedTests: [] },
    onPortInUse: "restart" as const,
    extraMavenArgs: [],
  };
}

function fitExecutionContext(): FitExecutionContext {
  return {
    kind: "local",
    description: "test execution",
    target: {
      kind: "local",
      description: "this machine",
      run: () => Promise.resolve(),
      capture: () => Promise.resolve(""),
      runHiddenUntilFailure: () => Promise.resolve(),
      putFile: () => Promise.resolve(),
      getFile: () => Promise.resolve(),
    },
    rootDir: "/tmp/root",
    fitPerformerDir: "/tmp/performer",
    jenkinsDir: "/tmp/jenkins",
    dockerCommand: "docker",
    artifacts: [],
    details: [],
    ensureWorkspace: () => Promise.resolve(true),
    ensureBuildWorkspace: () => Promise.resolve(true),
    run: () => Promise.resolve(),
    capture: () => Promise.resolve(""),
    runHiddenUntilFailure: () => Promise.resolve(),
    runToFile: () => Promise.resolve(),
    targetFilePath: (path) => path,
    stageFile: (path) => Promise.resolve(path),
    collectFile: () => Promise.resolve(),
    removeTree: () => Promise.resolve(),
    collectJunitArtifacts: () => Promise.resolve([]),
    pathExists: () => Promise.resolve(true),
    commandAvailable: () => Promise.resolve(true),
    performerRunArgs: () => [],
  };
}

test("setupCluster applies the allocated cbdinocluster to every functional iteration in the cycle", async () => {
  const cycle = functionalCycle();
  const execution = executor();
  let receivedExecution: ClusterCommandExecutor | undefined;

  const result = await setupCluster(cycle, execution, (_plan, passedExecution) => {
    receivedExecution = passedExecution;
    return Promise.resolve({
      allocated: true,
      clusterId: "cluster-id",
      cbdinocluster: "cbdinocluster",
      cluster: cluster(),
      artifacts: [],
      details: [],
    });
  });

  assert.equal(receivedExecution, execution);
  assert.deepEqual(result.group.runs.map((iteration) => iteration.cluster), [cluster(), cluster()]);
});

test("setupCluster leaves the iterations unchanged when allocation fails", async () => {
  const result = await setupCluster(functionalCycle(), executor(), () =>
    Promise.resolve({
      allocated: false,
      artifacts: [],
      details: [],
    }),
  );

  assert.deepEqual(result.group.runs.map((iteration) => iteration.cluster), [undefined, undefined]);
});

test("cbdinoclusterSetupFailed flags a missing cycle cluster after the cluster phase ran", () => {
  assert.equal(cbdinoclusterSetupFailed(functionalCycle(), true), true);

  const resolved = functionalCycle();
  resolved.runs = resolved.runs.map((iteration) => ({ ...iteration, cluster: cluster() }));
  assert.equal(cbdinoclusterSetupFailed(resolved, true), false);
  assert.equal(cbdinoclusterSetupFailed(functionalCycle(), false), false);
});

test("finalizeRunFromDefinition writes AGENTS.md and includes it in artifacts", () => {
  const runDir = mkdtempSync(join(tmpdir(), "fit-cli-run-from-definition-"));
  const result = finalizeRunFromDefinition([
    {
      filename: "instances/0/clusters/0/sessions/0/runs/0/driver.log",
      explanation: "FIT test-driver stdout/stderr captured for this run",
    },
  ], [], runDir);

  assert.deepEqual(result.artifacts.map((artifact) => artifact.filename), [
    "instances/0/clusters/0/sessions/0/runs/0/driver.log",
    "AGENTS.md",
  ]);
  const written = readFileSync(join(runDir, "AGENTS.md"), "utf8");
  assert.match(written, /instances\/0\/clusters\/0\/sessions\/0\/runs\/0\/driver\.log/);
});

test("runTests stops before later steps when the cluster REST sanity check fails", async () => {
  let generatedFitConfig = false;
  let checkedPerformer = false;
  let ranDriver = false;

  await assert.rejects(
    () =>
      runTests(fitExecutionContext(), "connection", iteration(), undefined, {
        runClusterDiagFn: () => Promise.resolve(false),
        generateFitConfigurationFn: () => {
          generatedFitConfig = true;
          return { path: "/tmp/fit.json", artifacts: [], details: [] };
        },
        runPerformerClusterSanityCheckFn: () => {
          checkedPerformer = true;
          return Promise.resolve({ ok: true, artifacts: [], details: [] });
        },
        runTestDriverFn: () => {
          ranDriver = true;
          return Promise.resolve({ ok: true, logFile: "/tmp/driver.log", artifacts: [], details: [] });
        },
      }),
    { message: "Cluster sanity test failed; this execution group cannot continue." },
  );

  assert.equal(generatedFitConfig, false);
  assert.equal(checkedPerformer, false);
  assert.equal(ranDriver, false);
});

function situationalIteration(): ResolvedSituationalExecutionRun {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  return {
    type: "situational",
    path: { instanceIndex: 0, sessionIndex: 0, runIndex: 0, clusterlessSession: true },
    sdk,
    performerPort: 8060,
    testSelection: { allTests: [], selectedTests: [] },
    onPortInUse: "restart",
    extraMavenArgs: ["-Dgroups=situational,cbDino"],
    databaseMode: "hosted",
  };
}

const READY_DATABASE = {
  ready: true as const,
  database: { jdbc: "jdbc:postgresql://db:5432/perf", username: "postgres", password: "secret" },
  artifacts: [],
  details: [],
};

test("runSituationalTests stops before generating a config when the database isn't ready", async () => {
  let generatedConfig = false;
  let ranDriver = false;

  const result = await runSituationalTests(fitExecutionContext(), situationalIteration(), {
    resolveResultsDatabaseFn: () => Promise.resolve({ ready: false, artifacts: [], details: [] }),
    generateSituationalConfigurationFn: () => {
      generatedConfig = true;
      return { path: "/tmp/fit.json", artifacts: [], details: [] };
    },
    runTestDriverFn: () => {
      ranDriver = true;
      return Promise.resolve({ ok: true, logFile: "/tmp/driver.log", artifacts: [], details: [] });
    },
  });

  assert.deepEqual(result, { artifacts: [], details: [] });
  assert.equal(generatedConfig, false);
  assert.equal(ranDriver, false);
});

test("runSituationalTests generates the situational config then runs the driver", async () => {
  const calls: string[] = [];
  let configPerformerPort: number | undefined;
  let driverMavenArgs: readonly string[] | undefined;

  const result = await runSituationalTests(fitExecutionContext(), situationalIteration(), {
    resolveResultsDatabaseFn: () => {
      calls.push("database");
      return Promise.resolve(READY_DATABASE);
    },
    generateSituationalConfigurationFn: (_db, _cbdino, _rootDir, _path, performerPort) => {
      calls.push("config");
      configPerformerPort = performerPort;
      return { path: "/tmp/fit.json", artifacts: [], details: [] };
    },
    runTestDriverFn: (_execution, _selection, _path, _fitConfigPath, extraMavenArgs) => {
      calls.push("driver");
      driverMavenArgs = extraMavenArgs;
      return Promise.resolve({ ok: true, logFile: "/tmp/driver.log", artifacts: [], details: [] });
    },
  });

  assert.deepEqual(calls, ["database", "config", "driver"]);
  assert.equal(configPerformerPort, 8060);
  assert.deepEqual(driverMavenArgs, ["-Dgroups=situational,cbDino"]);
  assert.ok(result.details.some((detail) => detail.label === "Results UI"));
});
