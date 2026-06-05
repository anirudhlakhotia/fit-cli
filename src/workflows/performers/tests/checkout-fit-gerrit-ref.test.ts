import assert from "node:assert/strict";
import test from "node:test";
import {
  checkoutFetchHeadArgs,
  fitPerformerGerritUrl,
  fitPerformerGerritFetchArgs,
  gitStatusIsClean,
  resolveFitGerritUser,
} from "../checkout-fit-gerrit-ref/checkout-fit-gerrit-ref.js";

test("resolveFitGerritUser prefers FIT_GERRIT_USER then GERRIT_USER", () => {
  assert.equal(resolveFitGerritUser({ FIT_GERRIT_USER: " programmatix " }), "programmatix");
  assert.equal(resolveFitGerritUser({ GERRIT_USER: "programmatix" }), "programmatix");
  assert.equal(resolveFitGerritUser({ FIT_GERRIT_USER: " ", GERRIT_USER: " " }), undefined);
});

test("fitPerformerGerritFetchArgs targets the FIT Gerrit repo with the configured user", () => {
  assert.equal(fitPerformerGerritUrl("programmatix"), "ssh://programmatix@review.couchbase.org:29418/transactions-fit-performer");
  assert.deepEqual(fitPerformerGerritFetchArgs("refs/changes/29/246329/1", "programmatix"), [
    "fetch",
    "ssh://programmatix@review.couchbase.org:29418/transactions-fit-performer",
    "refs/changes/29/246329/1",
  ]);
});

test("checkoutFetchHeadArgs checks out FETCH_HEAD", () => {
  assert.deepEqual(checkoutFetchHeadArgs(), ["checkout", "FETCH_HEAD"]);
});

test("gitStatusIsClean accepts only empty porcelain output", () => {
  assert.equal(gitStatusIsClean(""), true);
  assert.equal(gitStatusIsClean("\n"), true);
  assert.equal(gitStatusIsClean(" M performers/node"), false);
});
