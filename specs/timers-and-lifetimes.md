This doc covers the various timers and lifetimes apply, which might help with debugging.
This is a human-written doc.  Targeted, specific, reviewed LLM edits are permitted; but keep this doc concise and accurate.

# Timers
24h plus up to 6h - when dangling cloud instances get killed by https://github.com/couchbaselabs/fit-cli/actions/workflows/cleanup-instances.yaml
6h - how long a GHA can run
31h - the TTL set on cbdinocluster clusters (intentionally after even a dangling instance will get killed)
3h - the TTL set on cbdinocluster clusters allocated on shared infrastructure (Capella, CNG on the shared ROSA cluster).
12h - how long an AWS role (like fit-cli-role) can be assumed for (can be shorter in some situations). Note: if you're already on temporary credentials (SSO, an EC2 instance profile, or an already-assumed role) when assuming fit-cli-role, AWS silently caps the session at 1h instead, since DurationSeconds isn't set in that chained-assume path. Only a direct IAM user gets the full 12h. fit-cli's own AWS clients no longer feel this cap directly: they resolve credentials through a refreshing provider that re-assumes fit-cli-role once the session is within 5 minutes of expiry, so a run longer than 1h (e.g. a situational suite) doesn't fail teardown with `RequestExpired`. Credentials forwarded to a remote box are refreshed before upload but are still a point-in-time snapshot that expires there — surviving a multi-hour on-box run needs the box to have its own refreshing source (an IAM instance profile).
2h - SSH/SCP idle timeout for remote instance sessions (ServerAliveInterval=30 x ServerAliveCountMax=240), deliberately generous to allow long-running remote processes to keep the connection alive.
