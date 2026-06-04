/**
 * Unit tests for buildFitConfiguration.
 *
 * Run on their own:
 *   npm test
 *   node --import tsx --test src/workflows/fit-functional/steps/tests/build-fit-configuration.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTO_GENERATED_MARKER,
  buildFitConfiguration,
} from "../build-fit-configuration.js";

const credentials = { username: "Administrator", password: "password" };

test("every generated config carries the auto-generated marker", () => {
  const config = buildFitConfiguration({
    scheme: "couchbase",
    defaultHostname: "localhost",
    flavour: "self-managed",
    credentials,
    tls: null,
  });
  assert.equal(config["//"], AUTO_GENERATED_MARKER);
});

test("a self-managed cluster uses the localhost layout", () => {
  const config = buildFitConfiguration({
    scheme: "couchbase",
    defaultHostname: "localhost",
    flavour: "self-managed",
    credentials,
    tls: null,
  });

  const access = config.clusterAccess as Record<string, unknown>;
  assert.equal(access.connectionString, "couchbase://${defaultHostname}");
  assert.deepEqual(access.rest, { hostname: "${defaultHostname}", resolveDnsSrv: false });
  assert.deepEqual(access.proxy, { hostname: "localhost" });
  assert.equal(config.skipBucketCreation, undefined);
  assert.deepEqual(config.excludeTests, ["situational"]);
});

test("a Capella cluster resolves DNS SRV, skips bucket creation and drops the proxy", () => {
  const config = buildFitConfiguration({
    scheme: "couchbases",
    defaultHostname: "cb.abc.cloud.couchbase.com",
    flavour: "production-capella",
    credentials,
    tls: null,
  });

  const access = config.clusterAccess as Record<string, unknown>;
  assert.equal(access.connectionString, "couchbases://${defaultHostname}");
  assert.deepEqual(access.rest, { hostname: "${defaultHostname}", resolveDnsSrv: true, port: 18091 });
  assert.equal(access.proxy, null);
  assert.equal(config.skipBucketCreation, true);
  assert.deepEqual(config.excludeTests, ["situational", "ssh", "realCapella"]);
});

test("the tls choice is passed straight through", () => {
  const config = buildFitConfiguration({
    scheme: "couchbases",
    defaultHostname: "cb.abc.nonprod-project-avengers.com",
    flavour: "internal-capella",
    credentials,
    tls: { insecure: true },
  });
  const access = config.clusterAccess as Record<string, unknown>;
  assert.deepEqual(access.tls, { insecure: true });
});
