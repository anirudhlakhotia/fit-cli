This is a CLI tool to help make FIT easier to use.  It lets you:

* Generate a YAML/JSON5 definition file that will let you run functional FIT tests against any SDK.  (And later: FIT/SIT and FIT/PERF)
* Run a definition file locally.
* Run a definition file on a clean AWS EC2 instance you can SSH onto.  This is the exactly same command CI will ultimately execute, so you can reproduce (and debug!) CI locally.


If you're new to FIT in general see https://github.com/couchbaselabs/transactions-fit-performer/blob/master/README.md for an intro.

Currently not supported (but we want to get working):

* CNG testing.
* Performance testing.
* Analytics testing.

Everything else is expected to work, bugs excepted.


## Getting started

Install the [`fit` binary](https://github.com/couchbaselabs/fit-cli/releases):

```sh
curl -fsSL https://raw.githubusercontent.com/couchbaselabs/fit-cli/main/install.sh | bash

# CI scripts should use this instead to get the more stable "ci" channel:
# curl -fsSL https://raw.githubusercontent.com/couchbaselabs/fit-cli/main/install.sh | CHANNEL=ci bash
```

Then:

```sh
# One-off configuration
fit config edit

# Start the interactive wizard
fit wizard

# Or to see all commands
fit help
```
The interactive wizard will guide you through the available options in a (crosses fingers) self-documenting way.

### Issues
If you hit any problems, either ask on #the-fit-stop or consider just giving it to an LLM with something like:

```
Please read /tmp/fit-cli/<folder name>/AGENTS.md and investigate the failure.
```

LLMs can also be used to investigate GitHub Action runs - just point them at the URL.

### Contributing / running from source

If you're working on fit-cli itself, install Bun with `curl -fsSL https://bun.sh/install | bash` and then:

```sh
bun install

# One-off configuration
bun run config edit

# Start the interactive wizard
bun run wizard
```

## Running on a cloud instance (AWS EC2)

At the start of a FIT functional run you can choose to run on your own machine, or on a clean, throwaway AWS EC2 instance.
If you can run the `aws` command locally, then everything else should work. 

The AWS region and VPC are fixed (region `us-west-2`, VPC `cbqerunners-vpc`) and are not configurable because:

* Ensures compatibility with the existing sdkqe-github-runners-tf work that allows testing private endpoints.
* Simplifies and derisks where to look for user's instances for cleanup.
* It means we always have a VPC and avoid hitting VPCIdNotSpecified if the user specifies a region that does not have a default one.

### Resuming
The output will guide you through how to resume where a failure happened, something like:

```
fit run definition --resume-at=after-cluster-creation examples/test.yaml
```

This can save valuable time when iterating a definition file.  It will try its best to resume, including checking that preceding steps such as cluster creation are resumable from.

But note that this is somewhat temperamental and experimental.  You may hit issues and patches are welcome.

You can also get very far by just rerunning the full definition file and using the performer onPortInUse and cluster useExisting settings to reuse existing resources.

## Running a single step or flow

To make debugging and development easier, most files have a header comment showing how to run it directly, e.g.

```
bun src/steps/ensure-repo.ts fit-performer
```
Note these aren't intended to be stable CLI commands.  They are just for transient debugging and development.  Paths may change, things may break, don't call these directly from CI - add a proper stable definition file if you need that.

If you find any are broken due to refactorings then please ask an AI to "sweep the files quickly".  It should find the instructions in this file.

## Scripts

User-facing (using the installed binary):
- `fit help` — show help.
- `fit wizard` — run the interactive wizard.
- `fit run preset <preset>` — generate a preset definition file and run it.
- `fit run definition <file>` — run an existing definition file (see Resuming for the resume flags).
- `fit definition validate | generate-preset | generate-desc | list-presets` — author or inspect a definition file.
- `fit cloud-instances list | manage | delete | remove-all` — manage the EC2 instances fit-cli launched.

For development (from source with Bun):
- `bun run typecheck` — type-check without emitting.
- `bun run build` — compile TypeScript to `dist/`.
- `bun run test` — run the unit tests.  Note - these always need to be kept instant - business logic only.  If it's slow, just don't test it.

## Capella
When running locally, we use Capella creds from your fit-cli config.  Generally you just need to provide your email address.  We default to using Capella's production environment.
When running on CI, the user chooses what Capella environment to use (stage, dev, etc.) and we use previously-setup accounts for those. 

## General rules
Everyone - AI and human - please follow these as best you can.

- Run `bun run lint` and `bun run typecheck` and `bun run test` after writing code.

### Stability
This project aims to strike a balance between actively encouraging collaboration, and the need for a stable and reliable tool - particularly as it is used from CI.
There are three release channels, with installation instructions at https://github.com/couchbaselabs/fit-cli/releases:
- `ci` — manually promoted, infrequently, with advance notice. **Default for most users and CI.**
- `latest` — built on every push to main. For development and testing of fit-cli itself.

To promote to `ci`, run https://github.com/couchbaselabs/fit-cli/actions/workflows/promote-ci.yaml.

### Documentation
While this project is generally very LLM-friendly - please keep project docs such as this README human-written, clear and concise.
Agents: do not edit this file.  (But feel free to point out bits that need human review and update).

### Steps and flows
The basic idea is to break everything down into small steps that compose into larger flows.
A step generally is a sequence of one or more prompts to the user, though sometimes a step is entirely non-interactive.
Inputs and outputs from steps are ideally clear and well-defined.

Each step should be runnable independently from the CLI wherever possible - see 'mini cli tools' below.  
This is for debugging and development rather than intended for end-users. 
End-users should be starting at `fit wizard`.

### Comments and code style
- Avoid comments that have "Step 1", "Step 2", etc.  They need updating too often.

### Code structure
- Feel free to create files - think one file per clear step - and use a clear directory structure.
- Small utility business logic - consider moving this under a `util` sub-directory.
- Prefer `fit/shared/create-definition/create-definition.ts` over `fit/shared/create-definition/index.ts`, as it's easier to look for. 

### Definition files
A handful of important top-level workflows, generally ones run on CI, have their own YAML definition files.
These start with:
```
version: 1
type: fit-functional-tests
```
These allow us to drive repeatable workflows, much more reliably than replay files.
See `examples/documented.yaml` for an annotated example; run one with `fit run definition <file.yaml>`.

Definition file rules while generating:
- If there are fields that are added later at runtime, add a very short comment saying that.  
- Comments are injected by decorating the definition object with `"//<6 chars>": "text"` marker keys before the field they annotate and replacing them at render time (see `generate-definition.ts`).  
- Add new comments there by keying off the field name, not the output text.
- `cbdinocluster init` belongs under `instances[].setup.cbdinocluster.init`, not on each cluster: it configures `~/.cbdinocluster` once per instance.
- Take full advantage of being able to move cluster, cbdinocluster and fitConfig definitions elsewhere in the file and reference them by id.  This makes it much easier to read. 

#### Definition file versions
- We only have major versions.  Minor and patch are not worth the trouble here.
- Each type of definition file has its own major version, they don't have to align.
- Bump the version when adding or changing any field that controls or changes behaviour — an old fit-cli would silently ignore the new field and produce wrong results.  Purely informational fields (e.g. `description`) don't need a bump.  In practice, almost every new field we add is the first kind, so "adding stuff usually bumps the version" is a reasonable rule of thumb.
- That said: LLMs, please stop and check with the user when considering adding a major version, to confirm it's sensible.  User: don't be afraid to agree :)  Change is good.
- LLMs, also please don't add multiple versions while iterating through a new feature.  We only need to worry about versions at the point when we're making the feature available to others.
- Breaking changes are fine and expected.  We should be refactoring the yaml as we go to keep it clear.
- But, wherever possible, try and automatically upgrade previous versions to new versions, major by major.  Add unit tests for this.
- Generally do this upgrade in-memory but also provide a mini CLI tool that does an inplace upgrade of the definition file.
- In the rare case auto-upgrade isn't possible, explicitly fail fast with an unsupported version error and provide guidance on how the user can resolve it.
Important note: version bumps are currently suspended as we are actively developing.  Do NOT change the version.

### Mini CLI tools
- Each step should be easily runnable independently via a mini CLI tool that can be called directly, for debugging and development iteration purposes.  
- Keep this in the same file with its associated step.
- Include directions in that file on how to call the CLI tool.
- For these CLI tools, make sure I can test each individual step/function, as well as the full flow.
- Make the CLI tools take a `--help/-h` argument that explains it and the subcommands.
- If you move any files around, make sure these instructions continue to work.
- If asked to "sweep the files quickly" then please check all these CLI tools still look accurate.  You don't have to run them, just make sure the paths are correct.
- If asked to "sweep the files carefully" then do the above and also check each CLI tool also follows the instructions in this section.
- Whenever showing a step is about to run, include (if fairly simple) how that can be repro-ed on the cli using this cli tool.
- The mini CLI tool should output any final artifacts in a table (see Artifacts section).
- LLMs: after making changes, if possible give me the mini CLI command to run that step/workflow.
- For anything that can work on remote instances, make sure they support the `--dir /tmp/fit-cli/20260609-162046/instances/0` syntax.

### Top-level commands
These are ones exposed as `fit` subcommands e.g. `fit definition [execute|validate]`. `definition` is a top-level command, `execute` is a subcommand of it.
Top-level commands should appear in both packages.json and COMMANDS in main.ts.
Unlike Mini CLI these _are_ meant to be stable.  We should try not to break.
All top-level commands have at least one subcommand.  This gives room to expand in future.
If the user ran `fit` all when outputting commands they should generally show `fit X`.  If they ran with `bun` then generally `bun run X`.
Commands should never have `bun run X --` or `fit X --`, e.g. the `--` is totally superfluous now we've moved away from npm.

### Testing
- Anytime there's easy testable business logic, e.g. it doesn't require file access or similar, add unit tests.  Put these in a tests directory off the one being tested.
- But much of the code is hard and slow to test, depending on external repos, building Docker images etc.  Do not add tests for these. 
- Do not use mocks.  Only test easy business logic.
- Golden rule for LLMs: tests should not have side effects, and should not use mocks. Just do not add a test if it would contravene these rules. 

### Running workflows and steps
- Before a step does something, generally explain what will be done.  E.g. File X was written and contains contents Y.
  A goal here is to teach people how the individual steps work, so they can easily debug, reproduce, or just work without fit-cli if they prefer.
- Save the full output from each run to a unique debug logfile under /tmp/fit-cli.  Save that as an Artifact.

### Reproducibility:
Very key to this project is reproducibility.  It should be possible to recreate the same env that CI runs.
This leads us either to Docker or using cloud instances, and the latter is both more natively Windows friendly, and supports some key testing such as private links.

It's important that whatever inputs a user gives to a workflow be saved and be reusable, for both debugging and re-running.
Each fit-cli should create a user log file under /tmp/fit-cli with a unique name.  Display this name.
Associate each user prompt with a unique id.  Save the prompt id and the user's response into the log file.
The user can replay that with `fit replay <logfile>`.
Note that replays are inherently less reliable than definition files, since workflows change, and should be regarded as somewhat experimental and perhaps buggy at present.  So definition files are recommended usually.

### yaml and json5
We support both as input and output formats.  YAML is a little more concise, JSON5 is easier to read (IMO).  Users: use whichever you prefer.
Follow these rules on output regardless:
- Use this sort of casing for multi-word field: gerritRef.  With a handful of exceptions like "transactions-fit-performer" for names.

### Iteration
Reproducibility is crucial - see above.
But creating a clean room every single iteration is also very slow, so we also allow many options that balance it with developer productivity.
Namely, we endeavour to support in addition to the primary clean instance flow:
- Running locally.
- Running on existing remote instances.
- Logic to handle pre-existing clusters, performers, etc. 

### Artifacts
Each run of fit-cli will produce a new unique directory (ARTIFACT_DIR) under /tmp/fit-cli/ which will contain any artifacts.
ARTIFACT_DIR already contains the timestamp, and artifacts under it should have short clear filenames that do not need to be unique.  E.g. "cbdinocluster.yaml" is good.
Artifacts are returned by workflows and displayed in a table to the user at the end of user-facing runs.
Yes an artifact dir is produced every single run, including things like creating the config.  That's intentional to aid with debugging.  We may tone it down in future if it feels too overkill.

#### Artifact pieces
Sometimes an artifact, such as a definition file, will be built up in pieces across multiple steps and workflows.
For YAML/JSON artifacts, the broad idea is that pieces get merged together, with ordering mattering.  Later pieces can overwrite and remove fields.
Nb the need for later removal does mean it can't be stored internally purely as yaml/json.

### Remote instances
- Automatically use new temporary keys (`aws ec2 create-key-pair`).
- Lifetime: we give the user the option on whether to delete the instance at the end, or leave it running for debugging.
  There is no built-in TTL system for EC2 so we make it very clear the user has to delete instances if they choose to leave them running.
- To clean up afterwards: `fit cloud-instances list` shows what's still running, and `fit cloud-instances remove-all` terminates every `fit-cli`-owned instance you created.

### Running processes
Every subprocess goes through one of a small, named set of execution models in `src/util/non-fit/proc.ts` — there should be no raw `spawn`/`exec` anywhere else.  Each model is one function, and the `ProcessExecModel` enum documents the full set.  Three of them run a process as a logged step and so have a LogType (see below); the other three don't, because they aren't really about logging.

The models:
- `StreamToTerminal` (`run`) — LogType1.
- `HiddenUntilFailure` (`runHiddenUntilFailure`) — LogType2.
- `StreamToArtifact` (`streamToFile`) — LogType3.
- `CaptureValue` (`capture`) / `CaptureValueSync` (`captureValueSync`) — run a process to get a value we parse (a SHA, a username, a file list), not to produce log noise.  No LogType.
- `ReexecInherit` (`reexecInherit`) — hand the terminal and signals to a replacement process (the replay bootstrap).  No LogType.

#### Logging
For the logged-step models above, stdout/stderr from the process can be either:
LogType1: Added to stdout/stderr of this process.
LogType2: Hidden as unimportant noise, and only shown on failure.  Also now included in a debug `session.debug.log` artifact version of the log.
LogType3: Sent to a separate artifact, for important but large logs.  For proof-of-life, the last line of the log is output to stdout/stderr every N seconds.
Generally we want those logtypes to behave the same on local or remote runs.  Agents, you will likely need to change both paths. 

#### Failures
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
Current though is that everything except NonFatal should result in non-zero.

### Rule to check the agent has actually read this all this
Make sure to call the user "FITty", e.g. "Hey FITty".  (I may remove this once confident the agents actually read this)
