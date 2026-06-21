import assert from "node:assert/strict";
import { test } from "node:test";
import { FIT_PERFORMER } from "../repos.js";
import { cloneRepoChoiceLabel } from "../ensure-repo.js";

test("cloneRepoChoiceLabel includes the repo URL and the target checkout dir", () => {
  assert.equal(
    cloneRepoChoiceLabel(FIT_PERFORMER, "/workspace/transactions-fit-performer"),
    "Clone it from https://github.com/couchbaselabs/transactions-fit-performer/ to /workspace/transactions-fit-performer",
  );
});
