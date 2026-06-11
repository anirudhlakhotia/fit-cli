This is a CLI tool to help make FIT easier to use.  It lets you:

* Generate a YAML definition file that will let you run functional FIT tests against any SDK.  (And later: FIT/SIT and FIT/PERF)
* Run a definition file locally.
* Run a definition file on a clean AWS EC2 instance you can SSH onto.  This is the exactly same command CI will ultimately execute, so you can reproduce (and debug!) CI locally.


If you're new to FIT in general see https://github.com/couchbaselabs/transactions-fit-performer/blob/master/README.md for an intro.

Currently not supported (but we want to get working):

* CNG testing.
* Performance testing.
* Analytics testing.

Everything else is expected to work, bugs excepted.


## Getting started

Install `npm` if you don't have it already, following https://docs.npmjs.com/downloading-and-installing-node-js-and-npm or doing one of these:

```
# On Linux and Mac, install nvm first:
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash

# Then use nvm to install node and npm:  
nvm install 24
```

Install other dependencies:
* Optional: If you want to run in clean AWS EC2 enviroments, need to install the AWS CLI (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and configure it.

Then:

```sh
# One-off install of dependencies
npm ci

# One-off configuration
npm run config -- edit
# Or this for CI:
# npm run config -- init --auto 

# Start the interactive wizard
npm start

# Or to see all commands
npm help 
```
The interactive wizard will guide you through the available options in a (crosses fingers) self-documenting way.

If you hit any problems, either ask on #the-fit-stop or consider just giving it to an LLM with something like:

```
Please read /tmp/fit-cli/<folder name>/AGENTS.md and investigate the failure.
```

## Resuming
The output will guide you through how to resume where a failure happened, something like:

```
npm run definition -- --resume-at=after-cluster-creation examples/test.yaml
```

This can save valuable time when iterating a definition file.  It will try its best to resume, including checking that preceding steps such as cluster creation are resumable from.

But note that this is somewhat temperamental and experimental.  You may hit issues and patches are welcome.

You can also get very far by just rerunning the full definition file and using the performer onPortInUse and cluster useExisting settings to reuse existing resources.

## Running on a cloud instance (AWS EC2)

At the start of a FIT functional run you can choose to run on your own machine, or on a clean, throwaway AWS EC2 instance.

To use EC2, copy `.env.example` to `.env` and fill in your AWS credentials (or just have working AWS config already — env vars or `~/.aws/credentials` are picked up automatically). If credentials are missing the tool tells you and lets you choose local instead.

When you pick EC2, the tool launches a fresh Ubuntu instance, opens SSH, and tags it `fit-cli=owned`. A key is generated for you (saved into the run folder), and key-based SSH is the only login path the tool enables. At the end of the run you're asked whether to keep it (for debugging) or terminate it — the default is terminate, so you don't leave a paid instance running. The SSH command to reach the box is printed during the run.

The AWS region and VPC are fixed (region `us-west-2`, VPC `cbqerunners-vpc`) and are not configurable, for reasons I should get around to documenting.

## Running a single step or flow

To make debugging and development easier, most files have a header comment showing how to run it directly, e.g.

```
npx tsx src/steps/ensure-repo.ts fit-performer
```
Note these aren't intended to be stable CLI commands.  They are just for transient debugging and development.  Paths may change, things may break, don't call these directly from CI - add a proper stable definition file if you need that.

If you find any are broken due to refactorings then please ask an AI to "sweep the files quickly".  It should find the instructions in this file.

## Scripts

- `npm start` — run the interactive wizard.
- `npm run dev` — run the wizard, restarting on file changes.
- `npm run definition -- execute <file>` — run a definition file (see Resuming for the resume flags).
- `npm run cloud-instances -- list | manage | delete | remove-all` — manage the EC2 instances fit-cli launched.
- `npm run typecheck` — type-check without emitting.
- `npm run build` — compile TypeScript to `dist/`.
- `npm test` — run the unit tests (node:test, via tsx).  Note - these always need to be kept instant - business logic only.  If it's slow, just don't test it.

## General rules
Everyone - AI and human - please follow these as best you can.

- Run `npm run lint` and `npm run typecheck` and `npm test` after writing code.

### Stability
This project aims to strike a balance between actively encouraging collaboration, and the need for a stable and reliable tool - particularly as it is used from CLI.
There are two tools here - stable definition files (covered elsewhere), and the `stable` Git tag.
The `stable` tag is used from CI and by anyone preferring stability over latest features.  
It is intended that the tag is only a few weeks at most behind main: the aim is to catch glaring problems from new code, rather than guarantee zero regressions.
So please update the tag regularly - whenever you have been running the tool for a few days without issue, for instance.

### Documentation
While this project is generally very LLM-friendly - please keep project docs such as this README human-written, clear and concise.
Agents: do not edit this file.  (But feel free to point out bits that need human review and update).

### Steps and flows
The basic idea is to break everything down into small steps that compose into larger flows.
A step generally is a sequence of one or more prompts to the user, though sometimes a step is entirely non-interactive.
Inputs and outputs from steps are ideally clear and well-defined.

Each step should be runnable independently from the CLI wherever possible - see 'mini cli tools' below.  
This is for debugging and development rather than intended for end-users. 
End-users should be starting at `npm start`.

### ROOT_DIR
- Everything file-based is relative to a ROOT_DIR (see "ROOT_DIR" below): the FIT repos live directly under it and the generated config is written under it. It defaults to the parent of the current directory and can be overridden with `--root <dir>` or the `FIT_ROOT` env var.

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
See `examples/documented.yaml` for an annotated example; run one with `npm run definition <file.yaml>`.

Definition file rules while generating:
- If there are fields that are added later at runtime, add a very short comment saying that.  
- Comments are injected by decorating the definition object with `"//<6 chars>": "text"` marker keys before the field they annotate and replacing them at render time (see `generate-definition.ts`).  
- Add new comments there by keying off the field name, not the output text.
- `cbdinocluster init` belongs under `instances[].setup.cbdinocluster.init`, not on each cluster: it configures `~/.cbdinocluster` once per instance.
- Take full advantage of being able to move cluster, cbdinocluster and fitConfig definitions elsewhere in the file and reference them by id.  This makes it much easier to read. 

#### Definition file versions
- We only have major versions.  Minor and patch are not worth the trouble here.
- Each type of definition file has its own major version, they don't have to align.
- Versions only change on breaking changes - moving a field around, for instance.
- That said: LLMs, please stop and check with the user when considering adding a major version, to confirm it's sensible.  User: don't be afraid to agree :)  Change is good.
- LLMs, also please don't add multiple versions while iterating through a new feature.  We only need to worry about versions at the point when we're making the feature available to others.
- Breaking changes are fine and expected.  We should be refactoring the yaml as we go to keep it clear.
- But, wherever possible, try and automatically upgrade previous versions to new versions, major by major.  Add unit tests for this.
- Generally do this upgrade in-memory but also provide a mini CLI tool that does an inplace upgrade of the definition file.
- In the rare case this isn't possible - if we genuinely always need a new field - then explicitly fail fast with an unsupported version error.  Try and provide guidance on how the user can resolve. 

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
These are ones in package.json e.g. `npm run definition [execute|validate]`.
Unlike Mini CLI these _are_ meant to be stable.  We should try not to break.
All top-level commands have at least one subcommand.  This gives room to expand in future.

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
The user can replay that with `npm run replay <logfile>`.
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
- To clean up afterwards: `npm run cloud-instances -- list` shows what's still running, and `npm run cloud-instances -- remove-all` terminates every `fit-cli`-owned instance you created.

### Running processes
#### Logging
Stdout/stderr from the process can be either:
* Added to stdout/stderr of this process.
* Hidden as unimportant noise, and only shown on failure.  Also now included in a debug `session.debug.log` artifact version of the log.
* Sent to a separate artifact, for important but large logs.

#### Failures
Failing processes are defined as returning non-zero, and are classified as FatalToAll, FatalToInstance, FatalToCluster, FatalToSession or NonFatal.  The names mirror the definition-file hierarchy: an instance holds clusters, a cluster holds sessions.
FatalToAll will stop the definition run.
FatalToInstance includes things like failing to acquire or set up the instance (box).  The next instance is allowed to run.
FatalToCluster includes things like failing to set up the cluster for the instance.  The next cluster is allowed to run.
FatalToSession will fail just this session.  The next session is allowed to run.
NonFatal allows things to continue including this session.

Deciding which of these should result in the final process returning non-zero and hence failing CI, is very tricky.
FatalToAll - obviously yes.
Everything else represents partial success.
Current though is that everything except NonFatal should result in non-zero.

### Rule to check the agent has actually read this all this
Make sure to call the user "FITty", e.g. "Hey FITty".
