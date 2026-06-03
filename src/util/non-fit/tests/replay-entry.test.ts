import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildReplayDispatch } from "../replay-entry.js";

test("buildReplayDispatch uses the recorded entrypoint and args by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-replay-entry-"));
  const entrypoint = join(dir, "select-fit-tests.ts");
  const logFile = join(dir, "prompts.json");
  writeFileSync(entrypoint, "export {};\n");
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        version: 1,
        createdAt: "2026-06-03T00:00:00.000Z",
        invocation: {
          cwd: dir,
          entrypoint,
          args: ["--root", "/workspace", "status"],
        },
        prompts: [],
      },
      null,
      2,
    ),
  );

  assert.deepEqual(buildReplayDispatch(["--replay", logFile]), {
    entrypoint,
    args: ["--replay", logFile, "--root", "/workspace", "status"],
  });
});

test("buildReplayDispatch forwards explicit replay args instead of recorded args", () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-replay-entry-"));
  const entrypoint = join(dir, "select-fit-tests.ts");
  const logFile = join(dir, "prompts.json");
  writeFileSync(entrypoint, "export {};\n");
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        version: 1,
        createdAt: "2026-06-03T00:00:00.000Z",
        invocation: {
          cwd: dir,
          entrypoint,
          args: ["status"],
        },
        prompts: [],
      },
      null,
      2,
    ),
  );

  assert.deepEqual(buildReplayDispatch(["--replay", "--defaults", logFile, "--root", "/override"]), {
    entrypoint,
    args: ["--replay", "--defaults", logFile, "--root", "/override"],
  });
});
