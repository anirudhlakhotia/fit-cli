---
name: run-fit-test
description: Run a FIT test 
---
You're being asked to run a FIT test.  The test itself may be under development, and the performer/SDK side may also be under development.

## Setting up transactions-fit-performer
If the test is under development, you'll either have been directed towards (1) a local transactions-fit-performer worktree or repo, or (2) a Gerrit version of same.

If it's (2) you can just use it as-is with e.g. `--override setup.repos.transactions-fit-performer.gerritRef=refs/changes/45/249345/2`.

If you've been given a Gerrit URL then resolve it as so (no auth needed):

`curl -s "https://review.couchbase.org/changes/249597/detail?o=CURRENT_REVISION" | tail -n +2 | jq -r '.revisions[.current_revision].ref'`

If it's (1), you may be able to run the test locally. 
You can use ` --repo-dir transactions-fit-performer=<path>` to point at a particular worktree. 

## Setting up SDK/performer
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

## Setting up the FIT definition file
You can create a FIT definition file like follows (note the useful comments throughout):

```
{
 version: 1,
 type: 'fit',
 instances: [
   {
     // Run on localhost by default.  If the test can only run in the cloud, specify 'aws' instead. 
     localhost: {},
     clusters: [
       {
         clusterConfig: 'cluster-0',
         sessions: [
           {
             // This section may need changing to fit the SDK
             performer: {
               image: 'java-fit-performer:main',
               onPortInUse: 'reuse',
             },
             runs: [
               {
                 type: 'functional',
                 tests: {
                   // This section will definitely need changing. 
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
 // This will create a cluster if needed, or use the user's existing one if there's already one there.
 clusterConfigs: [
   {
     id: 'cluster-0',
     cbdinocluster: {
       config: {
         nodes: [
           {
             count: 3,
             // You may need to adjust this if the test clearly needs a particular version.
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
