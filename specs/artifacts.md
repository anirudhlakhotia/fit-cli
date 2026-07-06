This doc covers the final artifacts directory.
This is a human-written doc.  Targeted, specific, reviewed LLM edits are permitted; but keep this doc concise and accurate.

# Artifacts
Each run of fit-cli will produce a new unique directory (ARTIFACT_DIR) under /tmp/fit-cli/ which will contain any artifacts.
The goal here is to have a single place that contains everything a human or LLM needs to debug issues.
This can optionally include a cbcollect.  This takes some time to collect so is an opt-in.
ARTIFACT_DIR already contains the timestamp, and artifacts under it should have short clear filenames that do not need to be unique.  E.g. "cbdinocluster.yaml" is good.
Artifacts are returned by workflows and displayed in a table to the user at the end of user-facing runs.
Yes an artifact dir is produced every single run, including things like creating the config.  That's intentional to aid with debugging.  We may tone it down in future if it feels too overkill.

## Artifact pieces
Sometimes an artifact, such as a definition file, will be built up in pieces across multiple steps and workflows.
For YAML/JSON artifacts, the broad idea is that pieces get merged together, with ordering mattering.  Later pieces can overwrite and remove fields.
Nb the need for later removal does mean it can't be stored internally purely as yaml/json.
