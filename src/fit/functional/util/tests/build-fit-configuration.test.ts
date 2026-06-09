/**
 * Unit tests for buildFitConfiguration.
 *
 * Run on their own:
 *   npm test
 *   node --import tsx --test src/workflows/fit-functional/util/tests/build-fit-configuration.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTO_GENERATED_MARKER,
  buildFitConfiguration,
  firstHostname,
  runtimeFitConfigurationPiece,
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

test("performerPorts defaults to 8060 and reflects a custom port", () => {
  const cluster = {
    scheme: "couchbase",
    defaultHostname: "localhost",
    flavour: "self-managed",
    credentials,
    tls: null,
  } as const;
  assert.deepEqual(buildFitConfiguration(cluster).performerPorts, [8060]);
  assert.deepEqual(buildFitConfiguration(cluster, 9001).performerPorts, [9001]);
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
  assert.deepEqual(access.rest, { hostname: "localhost", resolveDnsSrv: false });
  assert.deepEqual(access.proxy, {
    "//": "The performer is running in Docker and needs to be able to connect to the FIT proxy (the test-driver) running on the host machine",
    hostname: "host.docker.internal",
  });
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

test("a CNG cluster splits clusterAccess into classic driver and couchbase2 performer blocks", () => {
  const config = buildFitConfiguration({
    scheme: "couchbase",
    defaultHostname: "172.19.0.2",
    flavour: "self-managed",
    credentials,
    tls: null,
    cng: { performerConnectionString: "couchbase2://172.19.0.2:32700", tls: { insecure: true } },
  });

  const access = config.clusterAccess as Record<string, unknown>;
  assert.equal(access.defaultHostname, "172.19.0.2");
  assert.deepEqual(access.driver, {
    "//": "The driver connects with classic, which lets it create users, inspect cluster configs, etc.",
    connectionString: "couchbase://${defaultHostname}",
    tls: null,
  });
  assert.deepEqual(access.performer, {
    connectionString: "couchbase2://172.19.0.2:32700",
    tls: { insecure: true },
  });
  // The FIT proxy doesn't support couchbase2 yet, and DNS SRV is off for CNG.
  assert.equal(access.proxy, null);
  assert.deepEqual(access.rest, { hostname: "172.19.0.2", resolveDnsSrv: false });
  assert.equal(config["//"], AUTO_GENERATED_MARKER);
  assert.deepEqual(config.excludeTests, ["situational"]);
  // A plain operational connectionString must NOT be emitted for CNG.
  assert.equal(access.connectionString, undefined);
});

test("a definition fitConfig piece can override defaults while runtime fields still win", () => {
  const config = buildFitConfiguration(
    {
      scheme: "couchbase",
      defaultHostname: "actual-host",
      flavour: "self-managed",
      credentials,
      tls: null,
    },
    9001,
    {
      excludeTests: ["openshift"],
      clusterAccess: {
        connectionString: "couchbase://user-host",
        username: "custom-user",
        password: "custom-password",
        defaultHostname: "stale-host",
      },
    },
  );

  const access = config.clusterAccess as Record<string, unknown>;
  assert.deepEqual(config.excludeTests, ["openshift"]);
  assert.deepEqual(config.performerPorts, [9001]);
  assert.equal(access.connectionString, "couchbase://user-host");
  assert.equal(access.username, "custom-user");
  assert.equal(access.password, "custom-password");
  assert.equal(access.defaultHostname, "actual-host");
});

test("when fitConfig has ${defaultHostname} for rest.hostname, runtime piece corrects it to the first IP", () => {
  const config = buildFitConfiguration(
    {
      scheme: "couchbase",
      defaultHostname: "172.18.0.2,172.18.0.4,172.18.0.3",
      flavour: "self-managed",
      credentials,
      tls: null,
    },
    8060,
    {
      clusterAccess: {
        connectionString: "couchbase://${defaultHostname}",
        rest: { hostname: "${defaultHostname}", resolveDnsSrv: false },
      },
    },
  );

  const access = config.clusterAccess as Record<string, unknown>;
  assert.equal(access.defaultHostname, "172.18.0.2,172.18.0.4,172.18.0.3");
  assert.deepEqual(access.rest, { hostname: "172.18.0.2", resolveDnsSrv: false });
});

test("runtimeFitConfigurationPiece patches both defaultHostname and rest.hostname", () => {
  const piece = runtimeFitConfigurationPiece({
    scheme: "couchbase",
    defaultHostname: "172.18.0.2,172.18.0.4,172.18.0.3",
    flavour: "self-managed",
    credentials,
    tls: null,
  });

  const access = (piece.data.clusterAccess as Record<string, unknown>);
  assert.equal(access.defaultHostname, "172.18.0.2,172.18.0.4,172.18.0.3");
  assert.deepEqual(access.rest, { hostname: "172.18.0.2" });
});

test("a multi-node self-managed cluster uses only the first IP for rest.hostname", () => {
  const config = buildFitConfiguration({
    scheme: "couchbase",
    defaultHostname: "172.18.0.2,172.18.0.4,172.18.0.3",
    flavour: "self-managed",
    credentials,
    tls: null,
  });

  const access = config.clusterAccess as Record<string, unknown>;
  assert.equal(access.defaultHostname, "172.18.0.2,172.18.0.4,172.18.0.3");
  assert.equal(access.connectionString, "couchbase://${defaultHostname}");
  assert.deepEqual(access.rest, { hostname: "172.18.0.2", resolveDnsSrv: false });
});

test("firstHostname extracts the first host from a comma-separated list", () => {
  assert.equal(firstHostname("172.18.0.2,172.18.0.4,172.18.0.3"), "172.18.0.2");
  assert.equal(firstHostname("localhost"), "localhost");
  assert.equal(firstHostname("  host1 , host2 "), "host1");
});
