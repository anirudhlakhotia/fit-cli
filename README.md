This is a CLI tool to help make FIT easier to use.

See ../transactions-fit-performer/README.md for an intro to FIT.

It's written with Node and Typescript.

## General rules

- Before doing something, generally explain what will be done.  E.g. File X was written and contains contents Y.
- Save the full output from each run to a unique debug logfile under /tmp/fit-cli.  Display the filename.
- Avoid comments that have "Step 1", "Step 2", etc.  They need updating too often.
- Feel free to create files - think one file per clear step - and use a clear directory structure. 
- Each step should be easily runnable independently via a small CLI tool that can be called directly, for debugging and development iteration purposes.  
  Keep this in the same file with its associated step.
  Include directions in that file on how to call the CLI tool.

## Getting started

```sh
npm install
npm start
```

`npm start` launches an interactive wizard. Today the only action is
**Run functional tests** (more will follow), which walks you through:

1. Checking that `../transactions-fit-performer` is present (offering to clone
   it if not).
2. Choosing which SDK to test. JVM SDKs (Java, Scala, Kotlin) additionally
   require `../couchbase-jvm-clients`, which the wizard will offer to clone.
3. Choosing whether to use an existing Couchbase cluster or create a new one.

## Structure

The wizard is split into one file per step. `src/index.ts` only orchestrates;
each step under `src/steps/` owns its own logic **and** a small CLI so it can be
run on its own during development. Shared helpers live in `src/lib/`.

```
src/
  index.ts                 wizard orchestrator (ties the steps together)
  lib/
    cli.ts                 isMain() + runCli() — shared step-CLI plumbing
    proc.ts                run() — stream a child process (git, mvn) to the console
    repos.ts               sibling-repo definitions + path/exists/clone helpers
    sdks.ts                the list of SDKs FIT can test
  steps/
    ensure-repo.ts         ensure a sibling repo is present (clone if missing)
    ensure-fit-grpc.ts     ensure fit-grpc is in the local Maven repo (build if stale)
    choose-sdk.ts          pick which SDK to test
    check-performer.ts     verify the chosen SDK's performer exists
    choose-cluster.ts      pick an existing cluster or create a new one
```

### Running a single step

Each step file's header comment shows how to run it directly. For example:

```sh
npx tsx src/steps/ensure-repo.ts fit-performer
npx tsx src/steps/check-performer.ts dotnet
npx tsx src/steps/ensure-fit-grpc.ts
```

## Scripts

- `npm start` — run the wizard with tsx.
- `npm run dev` — run the wizard, restarting on file changes.
- `npm run typecheck` — type-check without emitting.
- `npm run build` — compile TypeScript to `dist/`.
