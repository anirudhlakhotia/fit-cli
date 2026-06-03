import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chooseWorkflow } from "../index.js";
import { PromptSession } from "../util/non-fit/replay.js";

test("chooseWorkflow resumes the stored workflow and skips the legacy workflow prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-index-"));
  const logFile = join(dir, "workflow.json");
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        version: 1,
        createdAt: "2026-06-03T00:00:00.000Z",
        workflow: "functional-tests",
        prompts: [
          {
            id: "prompt-1",
            kind: "select",
            message: "What would you like to do?  [More options to follow - PRs welcome ;) ]",
            response: "functional-tests",
          },
          {
            id: "prompt-2",
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
  const choice = await chooseWorkflow(session);
  assert.equal(choice, "functional-tests");

  const response = await session.resolvePrompt("confirm", "Build FIT now?", () =>
    Promise.resolve(false),
  );
  assert.equal(response, true);
});

test("chooseWorkflow rejects unknown workflows from replay metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-index-"));
  const logFile = join(dir, "unknown-workflow.json");
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        version: 1,
        createdAt: "2026-06-03T00:00:00.000Z",
        workflow: "not-a-real-workflow",
        prompts: [],
      },
      null,
      2,
    ),
  );

  const session = PromptSession.fromArgv(["--replay", logFile]);
  await assert.rejects(() => chooseWorkflow(session), /Unknown workflow in replay log/);
});
