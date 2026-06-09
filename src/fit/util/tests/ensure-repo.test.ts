import assert from "node:assert/strict";
import { test } from "node:test";
import { FIT_PERFORMER } from "../repos.js";
import { cloneRepoChoiceLabel } from "../ensure-repo.js";

test("cloneRepoChoiceLabel includes the repo URL and exact ROOT_DIR-based path", () => {
  assert.equal(
    cloneRepoChoiceLabel(FIT_PERFORMER, "/workspace"),
    "Clone it from https://github.com/couchbaselabs/transactions-fit-performer/ to /workspace/transactions-fit-performer (under ROOT_DIR: /workspace)",
  );
});
