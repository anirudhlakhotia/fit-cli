This is a CLI tool to help make FIT easier to use.

See ../transactions-fit-performer/README.md for an intro to FIT.

While this project is generally very LLM-friendly - please keep project docs such as this README human-written, clear and concise.


## Getting started

Install `npm` if you don't have it already, following https://docs.npmjs.com/downloading-and-installing-node-js-and-npm or doing one of these:

```
# On Linux and Mac, install nvm first:
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash

# Then use nvm to install node and npm:  
nvm install 24
```

Then:

```sh
npm install
npm start
```

To launch an interactive wizard.

Your responses will be saved to a file, which you can then rerun to save time in future with:

```
`npm run replay <logfile>`
```

## Running a single step or flow

To make debugging and development easier, each step file's header comment shows how to run it directly, e.g.

```
npx tsx src/steps/ensure-repo.ts fit-performer
```

If you find any are broken due to refactorings then please ask an AI to "sweep the files quickly".  It should find the instructions in this file.

## Scripts

- `npm start` — run the wizard with tsx.
- `npm run dev` — run the wizard, restarting on file changes.
- `npm run typecheck` — type-check without emitting.
- `npm run build` — compile TypeScript to `dist/`.
- `npm test` — run the unit tests (node:test, via tsx).  Note - these always need to be kept instant - business logic only.  If it's slow, just don't test it.

## General rules
Everyone - AI and human - please follow these as best you can.

- Run `npm run lint` and `npm run typecheck` and `npm test` after writing code.

### Workflows
The basic idea is to break everything down into small workflows that compose into larger workflows.
A workflow generally is a sequence of one or more prompts to the user, though sometimes a workflow is entirely non-interactive.
Inputs and outputs from workflows are ideally clear and well-defined.

Each workflow should be runnable independently from the CLI wherever possible - see 'mini cli tools' below.  
This is for debugging and development rather than intended for end-users. 
End-users should be starting at `npm start`.

### ROOT_DIR
- Everything file-based is relative to a ROOT_DIR (see "ROOT_DIR" below): the FIT repos live directly under it and the generated config is written under it. It defaults to the parent of the current directory and can be overridden with `--root <dir>` or the `FIT_ROOT` env var.

### Comments and code style
- Avoid comments that have "Step 1", "Step 2", etc.  They need updating too often.

### Code structure
- Feel free to create files - think one file per clear step - and use a clear directory structure.
- Small utility business logic - consider moving this under a `util` sub-directory.

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

### Testing
- Anytime there's easy testable business logic, e.g. it doesn't require file access or similar, add unit tests.  Put these in a tests directory off the one being tested.
- But much of the code is hard and slow to test, depending on external repos, building Docker images etc.  Do not add tests for these. 
- Do not use mocks.  Only test easy business logic.

### Running workflows and steps
- Before a step does something, generally explain what will be done.  E.g. File X was written and contains contents Y.
  A goal here is to teach people how the individual steps work, so they can easily debug, reproduce, or just work without fit-cli if they prefer.
- Save the full output from each run to a unique debug logfile under /tmp/fit-cli.  Display the filename.

### Reproducibility:
It's important that whatever inputs a user gives to a workflow be saved and be reusable, for both debugging and re-running.
Each fit-cli should create a user log file under /tmp/fit-cli with a unique name.  Display this name.
Associate each user prompt with a unique id.  Save the prompt id and the user's response into the log file.
The user can replay that with `npm run replay <logfile>`.

### Artifacts
Each run of fit-cli will produce a new unique directory (ARTIFACT_DIR) under /tmp/fit-cli/ which will contain any artifacts.
Artifacts are returned by workflows and displayed in a table to the user at the end of user-facing ones like runFunctionalTests.