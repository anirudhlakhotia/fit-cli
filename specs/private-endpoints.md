This doc covers private endpoint testing.
This is a human-written doc.  Targeted, specific, reviewed LLM edits are permitted; but keep this doc concise and accurate.

Private endpoints allow connecting to a Capella cluster as though it was directly in your own VPC.  All traffic goes over the CSP rather than through the public internet.
On AWS the feature is called PrivateLink, on GCP it's PSC.

# Testing
Nothing particularly special infra-wise is required to test PE.  You can create an instance in any VPC and region and private-endpoint over to a Capella cluster in any other VPC/region.  See:

* https://couchbase.slack.com/archives/C05LNBVQRE3/p1783536523802259?thread_ts=1783518609.111639&cid=C05LNBVQRE3
* https://couchbase.slack.com/archives/C05LNBVQRE3/p1783601930764149?thread_ts=1783518609.111639&cid=C05LNBVQRE3
* https://gist.github.com/programmatix/a04b907d7f4c7da198540e834f66e286

The magic bit that enables private-endpoints is all in cbdinocluster:

```
# Enable private endpoints
cbdinocluster private-endpoints enable <cluster-id>
cbdinocluster private-endpoints setup-link <cluster-id> --auto  # Nb this calls the CSP's API
cbdinocluster private-endpoints connstr <cluster-id> --wait-visible
```

This is supported for both of the CSPs currently supported (AWS and GCP).

# Server support
This document won't over-document the server support since it could change over time.
At time of writing (Aug '26) the server (Capella control plane here) implements a single load balancer, with a port exposed for each node-service pair.
E.g. for a 3 node cluster running services KV and ns-server, you may have (with made-up ports):
Port 10000: KV on node 1
Port 10001: KV on node 2
Port 10002: KV on node 3
Port 10003: ns-server on node 1
etc.