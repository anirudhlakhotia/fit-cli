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
  For these CLI tools, let me override each step so I can test each part.  E.g. if one step checks if a path exists, let me pretend it doesn't.
  If you move any files around, make sure these instructions continue to work.
- Run `npm run lint` and `npm run typecheck` after writing code.
- Everything file-based is relative to a ROOT_DIR, which is the directory they ran the tool from by default, and can be overridden on CLI.
- Anytime there's easy testable business logic, e.g. it doesn't require file access or similar, add unit tests.  Put these in a tests directory off the one being tested.

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
### Running a single step or flow

Each step file's header comment shows how to run it directly, and a flow's
`index.ts` can be run the same way. For example:

```sh
npx tsx src/fit-functional-guided/index.ts                          # the whole flow
npx tsx src/steps/ensure-repo.ts fit-performer
npx tsx src/fit-functional-guided/steps/performers/check-performer.ts dotnet
npx tsx src/fit-functional-guided/steps/ensure-fit-grpc.ts
```

## Scripts

- `npm start` — run the wizard with tsx.
- `npm run dev` — run the wizard, restarting on file changes.
- `npm run typecheck` — type-check without emitting.
- `npm run build` — compile TypeScript to `dist/`.
