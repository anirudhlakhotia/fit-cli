import assert from "node:assert/strict";
import test from "node:test";
import { dockerLoginArgs, dockerLoginCommand, dockerPullArgs } from "../check-and-pull-performer.js";

test("dockerLoginArgs logs Docker into GHCR using password-stdin", () => {
  assert.deepEqual(dockerLoginArgs(), [
    "login",
    "ghcr.io",
    "--username",
    "x-access-token",
    "--password-stdin",
  ]);
});

test("dockerPullArgs pull the requested image reference", () => {
  assert.deepEqual(dockerPullArgs("ghcr.io/couchbase/java-fit-performer:main"), [
    "pull",
    "ghcr.io/couchbase/java-fit-performer:main",
  ]);
});

test("dockerLoginCommand avoids putting the token on the command line", () => {
  assert.equal(
    dockerLoginCommand("docker", "/tmp/fit-cli/token.txt"),
    "cat /tmp/fit-cli/token.txt | docker login ghcr.io --username x-access-token --password-stdin",
  );
});
