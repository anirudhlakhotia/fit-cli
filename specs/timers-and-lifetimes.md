This doc covers the various timers and lifetimes apply, which might help with debugging.
This is a human-written doc.  Targeted, specific, reviewed LLM edits are permitted; but keep this doc concise and accurate.

# Timers
24h plus up to 6h - when dangling cloud instances get killed by https://github.com/couchbaselabs/fit-cli/actions/workflows/cleanup-instances.yaml
6h - how long a GHA can run
31h - the TTL set on cbdinocluster clusters (intentionally after even a dangling instance will get killed)
12h - how long an AWS role (like fit-cli-role) can be assumed for (can be shorter in some situations)
