---
name: run-fit-test
description: Run a FIT test 
---
You're being asked to run a FIT test.  The test itself may be under development, and the performer/SDK side may also be under development.

If the test is under development, you'll either have been directed towards (1) a local transactions-fit-performer worktree or repo, or (2) a Gerrit version of same.

If it's (2) you can just use it as-is with e.g. `--override setup.repos.transactions-fit-performer.gerritRef=refs/changes/45/249345/2`.

If it's (1), you may be able to run the test locally. 
You can use ` --repo-dir transactions-fit-performer=<path>` to point at a particular worktree. 
You can create a FIT definition file like follows:

```
           {
             version: 1,
             type: 'fit',
             description: '{localhost:{cbdino(3n@8.0-stable):[{java@main,functional,SanityTest}]}}',
             instances: [
               {
                 localhost: {},
                 clusters: [
                   {
                     clusterConfig: 'cluster-0',
                     sessions: [
                       {
                         performer: {
                           image: 'java-fit-performer:main',
                           onPortInUse: 'reuse',
                         },
                         runs: [
                           {
                             type: 'functional',
                             tests: {
                               classes: [
                                 'com.couchbase.client.<YourTest>',
                               ],
                             },
                           },
                         ],
                       },
                     ],
                   },
                 ],
               },
             ],
             clusterConfigs: [
               {
                 id: 'cluster-0',
                 cbdinocluster: {
                   config: {
                     nodes: [
                       {
                         count: 3,
                         version: '8.0-stable',  // resolved by fit-cli at runtime
                         services: [
                           'kv',
                           'n1ql',
                           'index',
                           'fts',
                         ],
                       },
                     ],
                     docker: {
                       'kv-memory': 4096,
                       'fts-memory': 4096,
                     },
                   },
                   onClusterExists: 'useExisting',
                 },
               },
             ],
           }
```

The SDK and/or performer may have needed changes too.
These may be either (1) sat in a local repo or (2) on a Gerrit or Github somewhere.

If it's (2), the performer image needs building first.
You can do this with e.g. `bun run performer build jvm refs/changes/67/249367/2`

If it's (1), then the user is going to need to run the performer themselves and the FIT definition file will want onPortInUse: 'reuse' to use it.

Or the user may just want to test against the standard performer (no changes needed).  In which case something like this works:
```
 performer: {
   image: 'java-fit-performer:main',
   onPortInUse: 'fail',
 },
```

