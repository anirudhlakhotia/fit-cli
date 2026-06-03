import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import {
  checkPortAvailability,
  parseDockerPs,
  runningPerformerPsArgs,
  stopPerformerContainerArgs,
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
