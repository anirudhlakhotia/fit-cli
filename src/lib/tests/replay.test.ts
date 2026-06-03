import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PromptSession, extractReplayFlag } from "../replay.js";

test("extractReplayFlag pulls --replay out of argv", () => {
  assert.deepEqual(extractReplayFlag(["functional", "--replay", "/tmp/run.json", "--root", "/ws"]), {
    replayRequested: true,
    replayFile: "/tmp/run.json",
    positionals: ["functional", "--root", "/ws"],
  });
});

test("extractReplayFlag notices a missing logfile", () => {
  assert.deepEqual(extractReplayFlag(["functional", "--replay", "--root", "/ws"]), {
    replayRequested: true,
    replayFile: undefined,
    positionals: ["functional", "--root", "/ws"],
  });
});

test("record mode writes prompt responses to a log file", async () => {
  const session = PromptSession.fromArgv([]);

  const response = await session.resolvePrompt("input", "Which SDK?", () => Promise.resolve("node"));
  assert.equal(response, "node");

  const log = JSON.parse(readFileSync(session.logFile, "utf8")) as {
    prompts: Array<{ id: string; kind: string; message: string; response: string }>;
  };
  assert.deepEqual(log.prompts, [
    { id: "prompt-1", kind: "input", message: "Which SDK?", response: "node" },
  ]);
});

test("replay mode reuses saved prompt responses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-replay-"));
  const logFile = join(dir, "run.json");
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        version: 1,
        createdAt: "2026-06-03T00:00:00.000Z",
        prompts: [
          {
            id: "prompt-1",
            kind: "confirm",
            message: "Build FIT now?",
            response: true,
          },
        ],
      },
      null,
      2,
    ),
  );

  const session = PromptSession.fromArgv(["--replay", logFile]);
  const response = await session.resolvePrompt("confirm", "Build FIT now?", () =>
    Promise.resolve(false),
  );
  assert.equal(response, true);
});
