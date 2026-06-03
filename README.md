This is a CLI tool to help make FIT easier to use.

See ../transactions-fit-performer/README.md for an intro to FIT.


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
`npm start -- --replay <logfile>`
```

## ROOT_DIR

All workspace files are resolved against a single `ROOT_DIR`. The FIT repos live
directly under it (`<ROOT_DIR>/transactions-fit-performer`,
`<ROOT_DIR>/couchbase-jvm-clients`) and the generated
`FITConfiguration.json` is written under it.

It is resolved in this order:

1. `--root <dir>` / `--root=<dir>` / `-r <dir>` on the command line
2. the `FIT_ROOT` environment variable
3. the parent of the current directory (`$PWD/..`) — the default

The default is the parent of the cwd so that running from inside the `fit-cli`
checkout finds the repos as siblings (`../transactions-fit-performer`), the usual
layout. Every entry point prints the resolved `ROOT_DIR` on startup. The local
Maven repo (`~/.m2`) and the debug logs (`/tmp/fit-cli`) are global and are not
relative to `ROOT_DIR`.

```sh
npm start -- --root /path/to/workspace
FIT_ROOT=/path/to/workspace npm start
npx tsx src/steps/ensure-repo.ts fit-performer --root /path/to/workspace
```

## Running a single step or flow

To make debugging and development easier, each step file's header comment shows how to run it directly, e.g.

```
npx tsx src/steps/ensure-repo.ts fit-performer
```

If you find any are broken due to refactorings then please ask an AI to "sweep the files".  It should find the instructions in this file.

## Scripts

- `npm start` — run the wizard with tsx.
- `npm run dev` — run the wizard, restarting on file changes.
- `npm run typecheck` — type-check without emitting.
- `npm run build` — compile TypeScript to `dist/`.
- `npm test` — run the unit tests (node:test, via tsx).

## General rules
Everyone - AI and human - please follow these as best you can.

- Before a step does something, generally explain what will be done.  E.g. File X was written and contains contents Y.
- Save the full output from each run to a unique debug logfile under /tmp/fit-cli.  Display the filename.
- Avoid comments that have "Step 1", "Step 2", etc.  They need updating too often.
- Feel free to create files - think one file per clear step - and use a clear directory structure.
- Small utility business logic - consider moving this under a `util` sub-directory. 
- Each step should be easily runnable independently via a mini CLI tool that can be called directly, for debugging and development iteration purposes.  
  Keep this in the same file with its associated step.
  Include directions in that file on how to call the CLI tool.
  For these CLI tools, make sure I can test each individual step/function, as well as the full flow.
  Make the CLI tools take a `--help/-h` argument that explains it and the subcommands.
  If you move any files around, make sure these instructions continue to work.
  If asked to "sweep the files" then please check all these CLI tools still look accurate, and follow the instructions in this file.  You don't have to run them, just make sure the paths are correct.
  Whenever showing a step is about to run, include (if fairly simple) how that can be repro-ed on the cli using this cli tool.
- Run `npm run lint` and `npm run typecheck` after writing code.
- Everything file-based is relative to a ROOT_DIR (see "ROOT_DIR" below): the FIT repos live directly under it and the generated config is written under it. It defaults to the parent of the current directory and can be overridden with `--root <dir>` or the `FIT_ROOT` env var.
- Anytime there's easy testable business logic, e.g. it doesn't require file access or similar, add unit tests.  Put these in a tests directory off the one being tested.
- Reproducibility:
  It's important that whatever inputs a user gives to a workflow be saved and be reusable, for both debugging and re-running.
  Each fit-cli should create a user log file under /tmp/fit-cli with a unique name.  Display this name.
  Associate each user prompt with a unique id.  Save the prompt id and the user's response into the log file.
  The user can replay that with `npm start -- --replay <logfile>`.