This doc covers the various timers and lifetimes apply, which might help with debugging.
This is a human-written doc.  Targeted, specific, reviewed LLM edits are permitted; but keep this doc concise and accurate.

# Timers
24h plus up to 6h - when dangling cloud instances get killed by https://github.com/couchbaselabs/fit-cli/actions/workflows/cleanup-instances.yaml
6h - how long a GHA can run
31h - the TTL set on cbdinocluster clusters (intentionally after even a dangling instance will get killed)
3h - the TTL set on cbdinocluster clusters allocated on shared infrastructure (Capella, CNG on the shared ROSA cluster).
12h - how long an AWS role (like fit-cli-role) can be assumed for (can be shorter in some situations). Note: if you're already on temporary credentials (SSO, an EC2 instance profile, or an already-assumed role) when assuming fit-cli-role, AWS silently caps the session at 1h instead, since DurationSeconds isn't set in that chained-assume path. Only a direct IAM user gets the full 12h.
2h - SSH/SCP idle timeout for remote instance sessions (ServerAliveInterval=30 x ServerAliveCountMax=240), deliberately generous to allow long-running remote processes to keep the connection alive.
