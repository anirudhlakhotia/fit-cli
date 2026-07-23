This doc gives a concise overview of FIT (Functional and Integration Testing) itself - the testing system that fit-cli exists to make easier to run.  See the main [README.md](../README.md) for what fit-cli specifically does.
This is a human-written doc (well, sorta..).  Targeted, specific, reviewed LLM edits are permitted; but keep this doc concise and accurate.

For the full picture, see the [transactions-fit-performer README](https://github.com/couchbaselabs/transactions-fit-performer/blob/master/README.md).  This is a private repo, though you might find a local sibling checkout (dependent on user's setup).

# What FIT is
FIT tests SDKs against real Couchbase clusters.  A central "driver" tells per-SDK "performers" what operations to run, over a GRPC protocol.  This centralises test logic in the drivers, so each test is written once and reused across every SDK.

# Test types
- **Functional (FIT/FUN)** - correctness tests against a cluster: KV, query, transactions, etc.  Integration tests basically.
- **Situational (FIT/SIT)** - tests behaviour under irregular cluster conditions (node failures, rebalances, network partitions).
- **Performance (FIT/PERF)** - throughput/latency benchmarking.
- **Analytics functional** - functional tests against Enterprise Analytics / Capella Analytics clusters, driven by a dedicated Analytics-shaped driver (historically named `columnar-test-driver`).

fit-cli currently supports functional and situational testing.

# Drivers
There are three drivers, all living in [transactions-fit-performer](https://github.com/couchbaselabs/transactions-fit-performer):

- `test-driver` - functional and situational tests for the standard SDKs.
- `perf-driver` - performance tests for the standard SDKs.
- `columnar-test-driver` - functional and situational tests for the Analytics SDKs.

# Performers
A performer is a small per-SDK GRPC server that the driver drives.  fit-cli exclusively uses prebuilt Docker performer images (no building from source).  All performer images behave identically, modulo the SDK they wrap.

# Clusters
FIT needs a real Couchbase cluster to test against.  fit-cli supports several ways to get one (Capella, cbdinocluster-managed local/Docker clusters, CNG-on-OpenShift).

# Writing and running tests
There's many ways to run FIT tests particularly now that fit-cli exists.

You can run a published performer image:
```
fit performer run scala
```

More to come...
