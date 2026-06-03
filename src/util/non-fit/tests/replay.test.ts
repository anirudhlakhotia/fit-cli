import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PromptSession, extractReplayFlag } from "../replay.js";

async function captureLogs(run: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
  return logs;
}

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

test("record mode can serialize a prompt response before saving it", async () => {
  const session = PromptSession.fromArgv([]);

  const response = await session.resolvePrompt(
    "checkbox",
    "Which tests?",
    () => Promise.resolve(["a", "b"]),
    { serializeResponse: () => "All FIT tests selected" },
  );
  assert.deepEqual(response, ["a", "b"]);

  const log = JSON.parse(readFileSync(session.logFile, "utf8")) as {
    prompts: Array<{ id: string; kind: string; message: string; response: string }>;
  };
  assert.deepEqual(log.prompts, [
    {
      id: "prompt-1",
      kind: "checkbox",
      message: "Which tests?",
      response: "All FIT tests selected",
    },
  ]);
});

test("record mode formats a replay reminder with the logfile", () => {
  const session = PromptSession.fromArgv([]);

  assert.equal(
    session.formatReplayReminder(),
    `Prompt replay:\n  Log file: ${session.logFile}\n  Replay: npm run replay ${session.logFile}`,
  );
});

test("record mode persists the chosen workflow", () => {
  const session = PromptSession.fromArgv([]);
  session.setWorkflow("functional-tests");

  const log = JSON.parse(readFileSync(session.logFile, "utf8")) as {
    workflow?: string;
  };
  assert.equal(log.workflow, "functional-tests");
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

  let response: boolean | undefined;
  const logs = await captureLogs(async () => {
    const session = PromptSession.fromArgv(["--replay", logFile]);
    response = await session.resolvePrompt("confirm", "Build FIT now?", () =>
      Promise.resolve(false),
    );
    assert.equal(session.formatReplayReminder(), undefined);
  });

  assert.equal(response, true);
  assert.equal(logs.at(-1), "[replay] Build FIT now?\n  -> true");
});

test("replay mode hides password values in console output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-replay-"));
  const logFile = join(dir, "password.json");
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        version: 1,
        createdAt: "2026-06-03T00:00:00.000Z",
        prompts: [
          {
            id: "prompt-1",
            kind: "password",
            message: "Password to test with:",
            response: "super-secret",
          },
        ],
      },
      null,
      2,
    ),
  );

  const logs = await captureLogs(async () => {
    const session = PromptSession.fromArgv(["--replay", logFile]);
    const response = await session.resolvePrompt("password", "Password to test with:", () =>
      Promise.resolve("unused"),
    );
    assert.equal(response, "super-secret");
  });

  assert.equal(logs.at(-1), "[replay] Password to test with:\n  -> [hidden]");
});

test("replay mode can deserialize a stored prompt response", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-replay-"));
  const logFile = join(dir, "checkbox.json");
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        version: 1,
        createdAt: "2026-06-03T00:00:00.000Z",
        prompts: [
          {
            id: "prompt-1",
            kind: "checkbox",
            message: "Which tests?",
            response: "All FIT tests selected",
          },
        ],
      },
      null,
      2,
    ),
  );

  const session = PromptSession.fromArgv(["--replay", logFile]);
  const response = await session.resolvePrompt("checkbox", "Which tests?", () => Promise.resolve([]), {
    deserializeResponse: (stored) =>
      stored === "All FIT tests selected" ? ["a", "b"] : [],
  });

  assert.deepEqual(response, ["a", "b"]);
});

test("replay mode loads stored workflow metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-replay-"));
  const logFile = join(dir, "workflow.json");
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        version: 1,
        createdAt: "2026-06-03T00:00:00.000Z",
        workflow: "functional-tests",
        prompts: [],
      },
      null,
      2,
    ),
  );

  const session = PromptSession.fromArgv(["--replay", logFile]);
  assert.equal(session.getWorkflow(), "functional-tests");
});
