import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sdkByValue } from "../../../../util/sdk/sdks.js";
import type { ClusterCommandExecutor } from "../../../cluster/cluster-create/allocate-cluster.js";
import type { ResolvedDefinition } from "../../../fit-shared/definition/resolve-definition.js";
import type { FitExecutionContext } from "../../../fit-shared/util/remote-fit-run.js";
import type { ResolvedSituationalIteration } from "../../../fit-shared/definition/resolve-definition.js";
import {
  cbdinoclusterSetupFailed,
  finalizeRunFromDefinition,
  runSituationalTests,
  runTests,
  setupCluster,
} from "../run-from-definition.js";

function definition(): ResolvedDefinition {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  return {
    clusterMode: "cbdinocluster",
    cbdinocluster: {
      config: { nodes: [{ count: 1, version: "8.1.0-2188", services: ["kv"] }] },
      onClusterExists: "destroyAndRecreate",
    },
    iterations: [
      {
        type: "functional",
        sdk,
        performerPort: 8060,
        testSelection: { allTests: [], selectedTests: [] },
        onPortInUse: "restart",
        extraMavenArgs: [],
      },
      {
        type: "functional",
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

test("setupCluster applies the allocated cbdinocluster to every iteration", async () => {
  const cluster = {
    scheme: "couchbase" as const,
    defaultHostname: "localhost",
    flavour: "self-managed" as const,
    credentials: { username: "Administrator", password: "password" },
    tls: null,
  };
  const execution = executor();
  let receivedExecution: ClusterCommandExecutor | undefined;

  const result = await setupCluster(definition(), execution, (_plan, passedExecution) => {
    receivedExecution = passedExecution;
    return Promise.resolve({
      allocated: true,
      clusterId: "cluster-id",
      cbdinocluster: "cbdinocluster",
      cluster,
      artifacts: [],
      details: [],
    });
  });

  assert.equal(receivedExecution, execution);
  assert.deepEqual(
    result.resolved.iterations.map((iteration) =>
      iteration.type === "functional" ? iteration.cluster : undefined,
    ),
    [cluster, cluster],
  );
});

test("setupCluster leaves the iterations unchanged when allocation fails", async () => {
  const result = await setupCluster(definition(), executor(), () =>
    Promise.resolve({
      allocated: false,
      artifacts: [],
      details: [],
    }),
  );

  assert.deepEqual(
    result.resolved.iterations.map((iteration) =>
      iteration.type === "functional" ? iteration.cluster : undefined,
    ),
    [undefined, undefined],
  );
});

test("cbdinoclusterSetupFailed flags a missing shared cluster after the cluster phase ran", () => {
  assert.equal(cbdinoclusterSetupFailed(definition(), true), true);

  const resolved = definition();
  resolved.iterations = resolved.iterations.map((iteration) => ({ ...iteration, cluster: cluster() }));
  assert.equal(cbdinoclusterSetupFailed(resolved, true), false);
  // When the cluster phase was skipped (resumed), a missing cluster isn't a setup failure.
  assert.equal(cbdinoclusterSetupFailed(definition(), false), false);
});

test("finalizeRunFromDefinition writes AGENTS.md and includes it in artifacts", () => {
  const runDir = mkdtempSync(join(tmpdir(), "fit-cli-run-from-definition-"));
  const result = finalizeRunFromDefinition([
    { filename: "it0/driver.log", explanation: "FIT test-driver stdout/stderr captured for this run" },
  ], [], runDir);

  assert.deepEqual(result.artifacts.map((artifact) => artifact.filename), ["it0/driver.log", "AGENTS.md"]);
  const written = readFileSync(join(runDir, "AGENTS.md"), "utf8");
  assert.match(written, /it0\/driver\.log/);
});

test("runTests stops before later steps when the cluster REST sanity check fails", async () => {
  let generatedFitConfig = false;
  let checkedPerformer = false;
  let ranDriver = false;

  const result = await runTests(fitExecutionContext(), "connection", iteration(), undefined, 0, {
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
  });

  assert.deepEqual(result, { artifacts: [], details: [] });
  assert.equal(generatedFitConfig, false);
  assert.equal(checkedPerformer, false);
  assert.equal(ranDriver, false);
});

function situationalIteration(): ResolvedSituationalIteration {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  return {
    type: "situational",
    sdk,
    performerPort: 8060,
    testSelection: { allTests: [], selectedTests: [] },
    onPortInUse: "restart",
    extraMavenArgs: ["-Dgroups=situational,cbDino"],
    cbdino: { version: "7.6", cbDinoClusterAppPath: "cbdinocluster", enablePrivateEndpoint: false },
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

  const result = await runSituationalTests(fitExecutionContext(), situationalIteration(), 0, {
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

  const result = await runSituationalTests(fitExecutionContext(), situationalIteration(), 0, {
    resolveResultsDatabaseFn: () => {
      calls.push("database");
      return Promise.resolve(READY_DATABASE);
    },
    generateSituationalConfigurationFn: (_db, _cbdino, _rootDir, performerPort) => {
      calls.push("config");
      configPerformerPort = performerPort;
      return { path: "/tmp/fit.json", artifacts: [], details: [] };
    },
    runTestDriverFn: (_execution, _selection, _fitConfigPath, extraMavenArgs) => {
      calls.push("driver");
      driverMavenArgs = extraMavenArgs;
      return Promise.resolve({ ok: true, logFile: "/tmp/driver.log", artifacts: [], details: [] });
    },
  });

  assert.deepEqual(calls, ["database", "config", "driver"]);
  assert.equal(configPerformerPort, 8060);
  assert.deepEqual(driverMavenArgs, ["-Dgroups=situational,cbDino"]);
  // The results UI is surfaced as a detail so the run summary links to it.
  assert.ok(result.details.some((detail) => detail.label === "Results UI"));
});

test("runTests performs the cluster REST sanity check before the performer sanity check", async () => {
  const calls: string[] = [];

  const result = await runTests(fitExecutionContext(), "connection", iteration(), undefined, 0, {
    runClusterDiagFn: () => {
      calls.push("cluster");
      return Promise.resolve(true);
    },
    generateFitConfigurationFn: () => {
      calls.push("fit-config");
      return { path: "/tmp/fit.json", artifacts: [], details: [] };
    },
    runPerformerClusterSanityCheckFn: () => {
      calls.push("performer");
      return Promise.resolve({ ok: true, artifacts: [], details: [] });
    },
    runTestDriverFn: () => {
      calls.push("driver");
      return Promise.resolve({ ok: true, logFile: "/tmp/driver.log", artifacts: [], details: [] });
    },
  });

  assert.deepEqual(calls, ["cluster", "fit-config", "performer", "driver"]);
  assert.deepEqual(result, { artifacts: [], details: [] });
});
