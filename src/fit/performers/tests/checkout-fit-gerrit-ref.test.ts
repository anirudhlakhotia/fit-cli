import assert from "node:assert/strict";
import test from "node:test";
import {
  checkoutFetchHeadArgs,
  fitPerformerGerritUrl,
  fitPerformerGerritFetchArgs,
  gerritSshCommand,
  gitStatusIsClean,
  resolveFitGerritUser,
  resolveGerritUserFromGhCli,
  requireFitGerritUser,
} from "../checkout-fit-gerrit-ref/checkout-fit-gerrit-ref.js";
import { resolveGerritSshKey } from "../../util/config.js";

test("resolveFitGerritUser prefers FIT_GERRIT_USER then GERRIT_USER", () => {
  assert.equal(resolveFitGerritUser({ FIT_GERRIT_USER: " programmatix " }), "programmatix");
  assert.equal(resolveFitGerritUser({ GERRIT_USER: "programmatix" }), "programmatix");
  assert.equal(resolveFitGerritUser({ FIT_GERRIT_USER: " ", GERRIT_USER: " " }), undefined);
});

test("requireFitGerritUser resolves from env vars without hitting git config", () => {
  assert.equal(requireFitGerritUser({ FIT_GERRIT_USER: "programmatix" }), "programmatix");
  assert.equal(requireFitGerritUser({ GERRIT_USER: "programmatix" }), "programmatix");
});

test("resolveGerritUserFromGhCli returns undefined when gh config is absent", () => {
  assert.equal(resolveGerritUserFromGhCli({ HOME: "/nonexistent-home-for-test" }), undefined);
});

test("requireFitGerritUser throws a clear error when no username is available", () => {
  assert.throws(
    () => requireFitGerritUser({ HOME: "/nonexistent-home-for-test" }),
    /FIT_GERRIT_USER|GERRIT_USER|github\.user/,
  );
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

test("resolveGerritSshKey prefers FIT_GERRIT_KEY then GERRIT_SSH_KEY", () => {
  assert.equal(resolveGerritSshKey({ env: { FIT_GERRIT_KEY: "/path/to/key" } }), "/path/to/key");
  assert.equal(resolveGerritSshKey({ env: { GERRIT_SSH_KEY: "/path/to/key" } }), "/path/to/key");
  assert.equal(resolveGerritSshKey({ env: { FIT_GERRIT_KEY: "  /trimmed  " } }), "/trimmed");
});

test("resolveGerritSshKey returns undefined when no env var and no default keys exist", () => {
  assert.equal(resolveGerritSshKey({ env: { HOME: "/nonexistent-home-for-test" } }), undefined);
});

test("gerritSshCommand includes key path and disables host-key checking", () => {
  const cmd = gerritSshCommand("/home/user/.ssh/id_rsa");
  assert.ok(cmd.includes("-i /home/user/.ssh/id_rsa"), "should include -i with key path");
  assert.ok(cmd.includes("StrictHostKeyChecking=no"), "should disable host key checking");
  assert.ok(cmd.includes("IdentitiesOnly=yes"), "should restrict to specified identity");
});
