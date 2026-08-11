#!/usr/bin/env node
/**
 * Top-level entry for managing fit-cli's cloud instances. Operates on both AWS
 * EC2 and GCP by default (--cloud all); pass --cloud aws or --cloud gcp to
 * scope to one.
 *
 * This file is glue: parse argv, decide which cloud(s) to call, and render
 * the combined table. The actual per-cloud work (credential checks,
 * filtering, confirmation prompts, termination) lives in
 * cloud/util/aws/instances-cli.ts and cloud/util/gcp/instances-cli.ts.
 *
 * bun run cloud-instances list [--all-users] [--cloud aws|gcp|all] [--project <id>] [--zone <zone>]
 * bun run cloud-instances manage [--all-users] [--tag key=value] [--key <key-name>]
 * bun run cloud-instances remove <instance-id-or-name> [--force] [--cloud aws|gcp|all] [--project <id>] [--zone <zone>]
 * bun run cloud-instances remove-all [--all-users] [--older-than <duration>] [--dry-run] [--force] [--cloud aws|gcp|all] [--project <id>] [--zone <zone>]
 * bun run cloud-instances --help
 *
 * `manage` (the interactive browse/act TUI) is AWS-only for now — GCP's
 * list/remove/remove-all cover what the scheduled cleanup workflow needs.
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import * as aws from "../util/aws/instances-cli.js";
import * as gcp from "../util/gcp/instances-cli.js";
import { defaultGcpProjectZone } from "../util/gcp/gcp-cli.js";
import type { InstanceRow } from "../util/instance-row.js";

type Cloud = "aws" | "gcp" | "all";

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index !== -1 ? argv[index + 1] : undefined;
}

function parseCloud(argv: string[]): Cloud {
  const value = flag(argv, "cloud") ?? "all";
  if (value !== "aws" && value !== "gcp" && value !== "all") {
    throw new Error(`Invalid --cloud "${value}". Expected "aws", "gcp", or "all".`);
  }
  return value;
}

/** Resolve --project/--zone, falling back to environments.json5's defaults.gcp. Throws if either is still missing. */
function resolveGcpProjectZone(argv: string[]): { project: string; zone: string } {
  const defaults = defaultGcpProjectZone();
  const project = flag(argv, "project") ?? defaults.project;
  const zone = flag(argv, "zone") ?? defaults.zone;
  if (!project || !zone) {
    throw new Error(
      "GCP project/zone not resolved. Pass --project and --zone, or set defaults.gcp.project/zone in environments.json5.",
    );
  }
  return { project, zone };
}

/** Parse --older-than, throwing the usage error if it's passed with no value. Duration format itself is validated downstream. */
function parseOlderThan(argv: string[]): string | undefined {
  const value = flag(argv, "older-than");
  if (argv.includes("--older-than") && !value) {
    throw new Error("--older-than needs a duration, e.g. --older-than 24h.");
  }
  return value;
}

/**
 * Run an AWS-only and a GCP-only implementation of the same subcommand
 * according to `cloud`: just the one for "aws"/"gcp", or both in sequence
 * (never concurrently, so confirmation prompts don't interleave) for "all" —
 * the default. Both are attempted even if one fails, so e.g. a GCP outage
 * doesn't prevent EC2 cleanup from running; failures from either are combined
 * into a single thrown error so the overall command (and a CI job) still
 * fails loudly.
 */
async function runForClouds(
  cloud: Cloud,
  awsFn: () => Promise<void>,
  gcpFn: () => Promise<void>,
): Promise<void> {
  if (cloud === "aws") return awsFn();
  if (cloud === "gcp") return gcpFn();

  const errors: string[] = [];
  for (const [label, fn] of [
    ["AWS", awsFn],
    ["GCP", gcpFn],
  ] as const) {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`✗ ${label}: ${message}`);
      errors.push(`${label}: ${message}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

function helpText(): string {
  const p = runScriptPrefix("cloud-instances");
  return `Manage fit-cli cloud instances (AWS EC2 and GCP together by default).

Usage:
  ${p} list [--all-users] [--cloud aws|gcp|all] [--project <id>] [--zone <zone>]
  ${p} manage [--all-users] [--tag key=value] [--key <key-name>]   (AWS only)
  ${p} remove <instance-id-or-name> [--force] [--cloud aws|gcp|all] [--project <id>] [--zone <zone>]
  ${p} remove-all [--all-users] [--older-than <duration>] [--dry-run] [--force] [--cloud aws|gcp|all] [--project <id>] [--zone <zone>]
  ${p} --help

Subcommands:
  list        Show fit-cli instances (yours by default; --all-users for everyone's).
  manage      Interactively browse and act on AWS EC2 instances (terminate, view details).
              Scoped to your instances by default; --all-users for everyone's.
  remove      Terminate/delete an instance by id (AWS) or name (GCP); prompts for
              confirmation unless --force. With --cloud all (the default), looks the
              identifier up on both clouds and acts on whichever one has it.
  remove-all  Terminate/delete every fit-cli instance you created (add --all-users for
              everyone's; prompts for confirmation unless --force).

list / manage / remove / remove-all options:
  --cloud <aws|gcp|all>  Which cloud(s) to operate on (default: all).
  --project <id>     GCP project (default: environments.json5's defaults.gcp.project).
  --zone <zone>      GCP zone (default: environments.json5's defaults.gcp.zone).

list / manage / remove-all options:
  --all-users        Include instances created by everyone, not just you.

remove-all options:
  --older-than <d>   Only reap instances launched/created at least this long ago, e.g.
                     24h, 90m, 2d. Boxes whose age can't be determined are kept.
  --dry-run          List what would be terminated, then exit without touching it.
  --force            Skip the confirmation prompt (required for unattended runs,
                     e.g. the scheduled cleanup workflow).`;
}

/** Render rows from both clouds as a single terminal table, mirroring util/non-fit/artifacts.ts's table style. */
function formatInstancesTable(rows: InstanceRow[]): string {
  const headers = { cloud: "CLOUD", id: "ID", address: "ADDRESS", state: "STATE", creator: "CREATED-BY" } as const;
  const widths = {
    cloud: Math.max(headers.cloud.length, ...rows.map((r) => r.cloud.length)),
    id: Math.max(headers.id.length, ...rows.map((r) => r.id.length)),
    address: Math.max(headers.address.length, ...rows.map((r) => r.address.length)),
    state: Math.max(headers.state.length, ...rows.map((r) => r.state.length)),
    creator: Math.max(headers.creator.length, ...rows.map((r) => r.creator.length)),
  };
  const formatRow = (r: { cloud: string; id: string; address: string; state: string; creator: string }): string =>
    `${r.cloud.padEnd(widths.cloud)} | ${r.id.padEnd(widths.id)} | ${r.address.padEnd(widths.address)} | ${r.state.padEnd(widths.state)} | ${r.creator.padEnd(widths.creator)}`;
  return [
    formatRow(headers),
    `${"-".repeat(widths.cloud)}-+-${"-".repeat(widths.id)}-+-${"-".repeat(widths.address)}-+-${"-".repeat(widths.state)}-+-${"-".repeat(widths.creator)}`,
    ...rows.map(formatRow),
  ].join("\n");
}

/**
 * List instances across the requested cloud(s) as a single combined table —
 * unlike remove/remove-all, this always fans out to both clouds for --cloud
 * all rather than printing two separate per-cloud sections, since the whole
 * point of `list` is one glance at everything fit-cli owns.
 */
async function cmdList(argv: string[]): Promise<void> {
  const cloud = parseCloud(argv);
  const allUsers = argv.includes("--all-users");

  const sources: { name: "AWS" | "GCP"; fetch: () => Promise<InstanceRow[]> }[] = [];
  if (cloud === "aws" || cloud === "all") sources.push({ name: "AWS", fetch: () => aws.listInstanceRows(allUsers) });
  if (cloud === "gcp" || cloud === "all") {
    const { project, zone } = resolveGcpProjectZone(argv);
    sources.push({ name: "GCP", fetch: () => gcp.listInstanceRows({ allUsers, project, zone }) });
  }

  const rows: InstanceRow[] = [];
  const errors: string[] = [];
  for (const { name, fetch } of sources) {
    try {
      rows.push(...(await fetch()));
    } catch (err) {
      // A single explicitly-requested cloud fails hard; --cloud all is best-effort
      // (see runForClouds) so one cloud's outage doesn't hide the other's table.
      if (cloud !== "all") throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`✗ ${name}: ${message}`);
      errors.push(`${name}: ${message}`);
    }
  }

  if (rows.length === 0) {
    console.log("No fit-cli instances found.");
  } else {
    console.log(`Found ${rows.length} fit-cli instance(s):\n`);
    console.log(formatInstancesTable(rows));
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

async function cmdManage(argv: string[]): Promise<void> {
  const allUsers = argv.includes("--all-users");

  let query: aws.InstanceQuery;
  const key = flag(argv, "key");
  if (key) {
    query = { kind: "key", keyName: key };
  } else {
    const tag = flag(argv, "tag");
    query = {
      kind: "tag",
      tag: tag ? { key: tag.split("=")[0], value: tag.split("=")[1] ?? "" } : undefined,
    };
  }

  await aws.manageInstancesCli({ allUsers, query });
}

async function cmdRemove(argv: string[]): Promise<void> {
  const cloud = parseCloud(argv);
  const force = argv.includes("--force");
  const identifier = argv.find((arg) => !arg.startsWith("-"));
  if (!identifier) {
    throw new Error(`Usage: ${runScriptPrefix("cloud-instances")} remove <instance-id-or-name> [--force]`);
  }

  if (cloud === "aws") return aws.removeInstance(identifier, force);
  if (cloud === "gcp") {
    const { project, zone } = resolveGcpProjectZone(argv);
    return gcp.removeInstance({ name: identifier, force, project, zone });
  }

  // --cloud all (the default): a single instance is only ever on one cloud, so
  // look the identifier up on both (best-effort — a broken credential on one
  // side shouldn't stop us checking the other) and act on whichever finds it.
  if (await aws.findInstance(identifier)) {
    return aws.removeInstance(identifier, force);
  }

  let gcpProject: string | undefined;
  let gcpZone: string | undefined;
  try {
    ({ project: gcpProject, zone: gcpZone } = resolveGcpProjectZone(argv));
    if (await gcp.findInstance({ identifier, project: gcpProject, zone: gcpZone })) {
      return gcp.removeInstance({ name: identifier, force, project: gcpProject, zone: gcpZone });
    }
  } catch {
    // GCP project/zone unresolved or credentials unusable — fall through to the not-found error below.
  }

  throw new Error(
    `Instance ${identifier} not found in AWS (${aws.AWS_REGION})` +
      (gcpProject && gcpZone ? ` or GCP (${gcpProject}/${gcpZone}).` : ", and GCP couldn't be checked (see above)."),
  );
}

async function cmdRemoveAll(argv: string[]): Promise<void> {
  const cloud = parseCloud(argv);
  const allUsers = argv.includes("--all-users");
  const force = argv.includes("--force");
  const dryRun = argv.includes("--dry-run");
  const olderThan = parseOlderThan(argv);

  await runForClouds(
    cloud,
    () => aws.removeAllInstances({ allUsers, force, dryRun, olderThan }),
    () => {
      const { project, zone } = resolveGcpProjectZone(argv);
      return gcp.removeAllInstances({ allUsers, force, dryRun, olderThan, project, zone });
    },
  );
}

export function runCloudInstancesMain(): void {
  runCli(async () => {
    const [subcommand, ...rest] = process.argv.slice(2);

    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      console.log(helpText());
      if (!subcommand) process.exit(2);
      return;
    }

    if (subcommand === "list") {
      await cmdList(rest);
      return;
    }

    if (subcommand === "manage") {
      await cmdManage(rest);
      return;
    }

    if (subcommand === "remove") {
      await cmdRemove(rest);
      return;
    }

    if (subcommand === "remove-all") {
      await cmdRemoveAll(rest);
      return;
    }

    console.error(`Unknown subcommand: ${subcommand}\n`);
    console.error(helpText());
    process.exit(2);
  });
}

if (isMain(import.meta.url)) {
  runCloudInstancesMain();
}
