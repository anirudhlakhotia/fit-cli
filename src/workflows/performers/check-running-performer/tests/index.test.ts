import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import {
  checkPortAvailability,
  handlePortInUse,
  killProcessArgs,
  lsofPortArgs,
  parseDockerPs,
  parseLsofPids,
  runningPerformerPsArgs,
  stopPerformerContainerArgs,
  waitForPortFree,
  type PortInUseDeps,
} from "../index.js";

test("runningPerformerPsArgs filters docker ps by the requested performer image", () => {
  assert.deepEqual(runningPerformerPsArgs("performer-node-main"), [
    "ps",
    "--filter",
    "ancestor=performer-node-main",
    "--format",
    "{{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Ports}}",
  ]);
});

test("parseDockerPs extracts container summaries from docker ps output", () => {
  assert.deepEqual(
    parseDockerPs(
      [
        "abc123\tperformer-node-main\tfit-node\t0.0.0.0:8060->8060/tcp",
        "def456\tperformer-java-main\tfit-java\t",
      ].join("\n"),
    ),
    [
      {
        id: "abc123",
        image: "performer-node-main",
        name: "fit-node",
        ports: "0.0.0.0:8060->8060/tcp",
      },
      {
        id: "def456",
        image: "performer-java-main",
        name: "fit-java",
        ports: "",
      },
    ],
  );
});

test("stopPerformerContainerArgs stops all provided container ids", () => {
  assert.deepEqual(stopPerformerContainerArgs(["abc123", "def456"]), ["stop", "abc123", "def456"]);
});

test("checkPortAvailability reports false when the port is already bound", async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    assert.deepEqual(await checkPortAvailability(address.port), { available: false });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("checkPortAvailability reports true when the port is free", async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");

  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

  assert.deepEqual(await checkPortAvailability(port), { available: true });
});

test("lsofPortArgs lists the listening PIDs on a TCP port", () => {
  assert.deepEqual(lsofPortArgs(8060), ["-t", "-i", "tcp:8060", "-sTCP:LISTEN"]);
});

test("parseLsofPids extracts unique positive PIDs from lsof output", () => {
  assert.deepEqual(parseLsofPids("123\n456\n123\n\n  789  \n"), [123, 456, 789]);
});

test("parseLsofPids ignores non-numeric lines", () => {
  assert.deepEqual(parseLsofPids("not-a-pid\n0\n-5\n42\n"), [42]);
});

test("killProcessArgs renders PIDs as kill arguments", () => {
  assert.deepEqual(killProcessArgs([123, 456]), ["123", "456"]);
});

test("waitForPortFree resolves true once the port frees up", async () => {
  const availability = [{ available: false }, { available: false }, { available: true }];
  let sleeps = 0;
  const freed = await waitForPortFree(8060, {
    maxAttempts: 5,
    checkAvailability: () => Promise.resolve(availability.shift() ?? { available: true }),
    sleep: () => {
      sleeps++;
      return Promise.resolve();
    },
  });
  assert.equal(freed, true);
  assert.equal(sleeps, 2);
});

test("waitForPortFree resolves false when the port stays in use", async () => {
  const freed = await waitForPortFree(8060, {
    maxAttempts: 3,
    checkAvailability: () => Promise.resolve({ available: false }),
    sleep: () => Promise.resolve(),
  });
  assert.equal(freed, false);
});

function portInUseDeps(overrides: Partial<PortInUseDeps>): PortInUseDeps {
  return {
    confirm: () => Promise.resolve(false),
    stopProcessesOnPort: () => Promise.resolve(true),
    waitForPortFree: () => Promise.resolve(true),
    ...overrides,
  };
}

test("handlePortInUse tests against an external performer when the user agrees", async () => {
  const result = await handlePortInUse(8060, portInUseDeps({ confirm: () => Promise.resolve(true) }));
  assert.deepEqual(result, { action: "external" });
});

test("handlePortInUse aborts when the user declines both options", async () => {
  const result = await handlePortInUse(8060, portInUseDeps({ confirm: () => Promise.resolve(false) }));
  assert.deepEqual(result, { action: "abort" });
});

test("handlePortInUse stops the process and starts once the port frees up", async () => {
  const answers = [false, true];
  let stopped = false;
  const result = await handlePortInUse(
    8060,
    portInUseDeps({
      confirm: () => Promise.resolve(answers.shift() ?? false),
      stopProcessesOnPort: () => {
        stopped = true;
        return Promise.resolve(true);
      },
      waitForPortFree: () => Promise.resolve(true),
    }),
  );
  assert.equal(stopped, true);
  assert.deepEqual(result, { action: "start" });
});

test("handlePortInUse aborts when the port never frees up after stopping", async () => {
  const answers = [false, true];
  const result = await handlePortInUse(
    8060,
    portInUseDeps({
      confirm: () => Promise.resolve(answers.shift() ?? false),
      waitForPortFree: () => Promise.resolve(false),
    }),
  );
  assert.deepEqual(result, { action: "abort" });
});
