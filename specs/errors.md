This doc covers the error model.
This is a human-written doc.  Targeted, specific, reviewed LLM edits are permitted; but keep this doc concise and accurate.

# Failures
Failing processes are defined as returning non-zero, and are classified as FatalToAll, FatalToInstance, FatalToCluster, FatalToSession or NonFatal.  The names mirror the definition-file hierarchy: an instance holds clusters, a cluster holds sessions.
FatalToAll will stop the definition run.
FatalToInstance includes things like failing to acquire or set up the instance (box).  The next instance is allowed to run.
FatalToCluster includes things like failing to set up the cluster for the instance.  The next cluster is allowed to run.
FatalToSession will fail just this session.  The next session is allowed to run.
FatalToRun will fail just this run.  The next run is allowed to, uh, run.
NonFatal allows things to continue including this session.

Deciding which of these should result in the final process returning non-zero and hence failing CI, is very tricky.
FatalToAll - obviously yes.
Everything else represents partial success.
