import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAX_AUTO_DECOMPRESS_BYTES,
  remoteAptCleanupCommand,
  remoteAptGetCommand,
  remoteAptWaitCommand,
  shouldAutoDecompress,
} from "../util/remote-fit-execution-context.js";

test("shouldAutoDecompress allows files at or under the default threshold", () => {
  assert.equal(shouldAutoDecompress(1024), true);
  assert.equal(shouldAutoDecompress(DEFAULT_MAX_AUTO_DECOMPRESS_BYTES), true);
});

test("shouldAutoDecompress rejects files over the default threshold", () => {
  assert.equal(shouldAutoDecompress(DEFAULT_MAX_AUTO_DECOMPRESS_BYTES + 1), false);
  assert.equal(shouldAutoDecompress(802.6 * 1024 * 1024), false);
});

test("shouldAutoDecompress honours a custom threshold", () => {
  assert.equal(shouldAutoDecompress(2000, 1000), false);
  assert.equal(shouldAutoDecompress(1000, 1000), true);
});

test("remoteAptWaitCommand waits for cloud-init and apt activity to finish", () => {
  const command = remoteAptWaitCommand();
  assert.match(command, /cloud-init status --wait/);
  assert.match(command, /pgrep -x apt-get/);
  assert.match(command, /pgrep -x dpkg/);
  assert.match(command, /sleep 2/);
  assert.doesNotMatch(command, /unattended-upgrade/);
  assert.doesNotMatch(command, /do;/);
  assert.doesNotMatch(command, /then;/);
});

test("remoteAptCleanupCommand clears apt lists without deleting the lock file", () => {
  const command = remoteAptCleanupCommand();
  assert.match(command, /find \/var\/lib\/apt\/lists -mindepth 1 -maxdepth 1 ! -name lock -exec rm -rf -- \{\} \+/);
  assert.match(command, /install -d -m 755 \/var\/lib\/apt\/lists\/partial/);
});

test("remoteAptGetCommand sets noninteractive mode and a lock timeout", () => {
  assert.equal(
    remoteAptGetCommand("install -y git"),
    "sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -y git",
  );
});
