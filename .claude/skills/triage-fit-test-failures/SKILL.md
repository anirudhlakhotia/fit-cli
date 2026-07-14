---
name: triage-fit-test-failures
description: Investigate and triage FIT failures on GHA or local runs. 
---
You're being asked to look at a particular GHA run(s), or local runs (will be artifact director(ies) in this sort of format: `/tmp/fit-cli/20260713-131603-074e`).

If it's GHAs I only want you to look at most recent runs - don't go back through history, unless asked.

Please group and triage the failures you find.  I'd like a brief explanation of what the failing tests are doing and how they have failed.  You'll find the local test-driver source useful for this.
Also do a timeboxed investigation into _why_ they have failed too, but that isn't the initial priority.  We're aiming for initial triage here.  I may ask you later to dig into particular failures.
That said, please do look into each test failure grouping in at least some level of detail.  Don't skim over.
You almost certainly want to use the artifacts to help.  If this is a GHA run you can use `bun run archive fetch <s3-zip-uri>` for this.

You _may_ find local sources in sister repos, depending on how the user has checked out `fit-cli`.
You will likely particularly find transactions-fit-performer useful.  You may also find the SDK/performer source useful. 

Use sub-agents as necessary to e.g. dig through large logs.

You may find docs in `project_root/specs` useful, particularly `specs/fit-testing-overview.md` to see what FIT is.

Specific to transactions test failures:
* There is logic in transactions-fit-performer that will dump the last transactions logs received on failure (`TestFailureHandler`), into the driver log.  This, sometimes alongside performer/SDK logs which should be available, can be very helpful.  Note not all SDKs do return the transaction logs - JVM ones do.
