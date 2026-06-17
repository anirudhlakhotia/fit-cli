/**
 * Workflow: list prebuilt performer containers from GHCR, or interactively pick
 * one for a given SDK.
 *
 * Run on its own:
 *   npx tsx src/fit/performers/list-docker-containers/list-docker-containers.ts java
 *   npx tsx src/fit/performers/list-docker-containers/list-docker-containers.ts --url https://github.com/couchbase/couchbase-jvm-clients/pkgs/container/java-fit-performer --compact
 *   npx tsx src/fit/performers/list-docker-containers/list-docker-containers.ts --help
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { input, select } from "../../../util/non-fit/prompts.js";
import { resolveGithubToken } from "../../util/config.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import { sdkByValue, type Sdk } from "../../../util/sdk/sdks.js";
import {
  normalizePerformerVersion,
  performerImageName,
  performerPackageUrl,
  sdkDefaultPerformerTag,
  validatePerformerVersion,
} from "../util/performer-image.js";

export interface GhcrPackageVersion {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  package_html_url?: string;
  metadata?: {
    container?: {
      tags?: string[];
    };
  };
  [key: string]: unknown;
}

export interface ParsedGhcrPackageUrl {
  owner: string;
  repo?: string;
  packageName: string;
}

interface ListDockerContainersCliArgs {
  help: boolean;
  json: boolean;
  compact: boolean;
  limit?: number;
  urls: string[];
  sdk?: Sdk;
}

export class PackageNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageNotFoundError";
  }
}

export class GhcrHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = "GhcrHttpError";
  }
}

function usage(): string {
  return [
    "Usage:",
    "  tsx src/workflows/performers/list-docker-containers/list-docker-containers.ts [<sdk>]",
    "  tsx src/workflows/performers/list-docker-containers/list-docker-containers.ts --url <ghcr-url>[,<ghcr-url>...] [--json] [--compact] [--limit N]",
    "",
    "Examples:",
    "  tsx src/workflows/performers/list-docker-containers/list-docker-containers.ts java",
    "  tsx src/workflows/performers/list-docker-containers/list-docker-containers.ts --url https://github.com/couchbase/couchbase-jvm-clients/pkgs/container/java-fit-performer --compact",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a GitHub container package URL into owner/repo/package coordinates.
 *
 * Accepts two forms:
 *   repo-scoped:  https://github.com/{owner}/{repo}/pkgs/container/{package}
 *   org-scoped:   https://github.com/orgs/{org}/packages/container/package/{package}
 */
export function parseGhcrPackageUrl(rawUrl: string): ParsedGhcrPackageUrl {
  const url = new URL(rawUrl);
  const segments = url.pathname.split("/").filter(Boolean);

  if (url.hostname !== "github.com") {
    throw new Error(
      "Expected a GitHub package URL like https://github.com/{owner}/{repo}/pkgs/container/{package}: " +
        rawUrl,
    );
  }

  // org-scoped: /orgs/{org}/packages/container/package/{package}
  if (segments[0] === "orgs" && segments[2] === "packages" && segments[3] === "container" && segments[4] === "package") {
    return { owner: segments[1], packageName: segments[5] };
  }

  // repo-scoped: /{owner}/{repo}/pkgs/container/{package}
  if (segments.length >= 5 && segments[2] === "pkgs" && segments[3] === "container") {
    return { owner: segments[0], repo: segments[1], packageName: segments[4] };
  }

  throw new Error(
    "Expected a GitHub package URL like https://github.com/{owner}/{repo}/pkgs/container/{package}" +
      " or https://github.com/orgs/{org}/packages/container/package/{package}: " +
      rawUrl,
  );
}

function nextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) {
    return undefined;
  }
  for (const part of linkHeader.split(",")) {
    const trimmed = part.trim();
    const match = trimmed.match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
    if (match?.[2] === "next") {
      return match[1];
    }
  }
  return undefined;
}

function formatHttpError(status: number, url: string, body: string): string {
  const detail = body.trim();
  return `GitHub Packages request failed (${status}) for ${url}${detail ? `: ${detail}` : ""}`;
}

async function fetchPackageVersionsFromApi(
  apiUrl: string,
  token: string,
  limit?: number,
): Promise<GhcrPackageVersion[]> {
  const versions: GhcrPackageVersion[] = [];
  let nextUrl: string | undefined = apiUrl;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "fit-cli",
      },
    });
    const body = await response.text();

    if (!response.ok) {
      throw new GhcrHttpError(response.status, nextUrl, formatHttpError(response.status, nextUrl, body));
    }

    let payload: unknown;
    try {
      payload = body ? JSON.parse(body) : [];
    } catch (err) {
      throw new GhcrHttpError(
        response.status,
        nextUrl,
        `Could not parse GitHub Packages response from ${nextUrl}: ${(err as Error).message}`,
      );
    }

    if (!Array.isArray(payload)) {
      throw new GhcrHttpError(response.status, nextUrl, `Expected an array response from ${nextUrl}.`);
    }

    for (const item of payload) {
      if (isRecord(item)) {
        versions.push(item as GhcrPackageVersion);
        if (limit !== undefined && versions.length >= limit) {
          return versions.slice(0, limit);
        }
      }
    }

    nextUrl = nextLink(response.headers.get("link"));
  }

  return versions;
}

/** Fetch every GHCR version object for a package URL. */
export async function fetchGhcrPackageVersions(
  packageUrl: string,
  token: string,
  limit?: number,
): Promise<GhcrPackageVersion[]> {
  const parsed = parseGhcrPackageUrl(packageUrl);
  let lastError: GhcrHttpError | undefined;

  for (const scope of ["orgs", "users"] as const) {
    const apiUrl =
      `https://api.github.com/${scope}/${parsed.owner}/packages/container/${parsed.packageName}/versions?per_page=100`;
    try {
      return await fetchPackageVersionsFromApi(apiUrl, token, limit);
    } catch (err) {
      if (err instanceof GhcrHttpError && err.status === 404) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw new PackageNotFoundError(
    `Could not find the GHCR package ${parsed.packageName} under ${parsed.owner} (${packageUrl}).` +
      (lastError ? ` Last error: ${lastError.message}` : ""),
  );
}

/** Flatten all container tags, preserving their first-seen order. */
export function collectContainerTags(versions: readonly GhcrPackageVersion[]): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();

  for (const version of versions) {
    for (const tag of version.metadata?.container?.tags ?? []) {
      if (!seen.has(tag)) {
        seen.add(tag);
        tags.push(tag);
      }
    }
  }

  return tags;
}

/** Prefer the SDK's default tag when available, otherwise the first returned tag. */
export function preferredContainerTag(sdk: Sdk, tags: readonly string[]): string | undefined {
  const defaultTag = sdkDefaultPerformerTag(sdk);
  return tags.includes(defaultTag) ? defaultTag : tags[0];
}

/** Render the Groovy-style human-readable container list. */
export function formatHumanContainerVersions(versions: readonly GhcrPackageVersion[]): string {
  if (versions.length === 0) {
    return "No container versions found.";
  }

  const lines = [`${versions.length} container version(s):`];
  for (const version of versions) {
    lines.push("-".repeat(60));
    lines.push(`id:          ${String(version.id)}`);
    lines.push(`digest:      ${version.name}`);
    const tags = version.metadata?.container?.tags;
    lines.push(`tags:        ${tags && tags.length > 0 ? tags.join(", ") : "(untagged)"}`);
    lines.push(`created_at:  ${version.created_at}`);
    lines.push(`updated_at:  ${version.updated_at}`);
    lines.push(`html_url:    ${version.html_url}`);
    lines.push(`package_url: ${version.package_html_url ?? ""}`);
    lines.push(`metadata:    ${JSON.stringify(version.metadata ?? {})}`);
  }
  return lines.join("\n");
}

/** Render the Groovy-style compact tag-only output. */
export function formatCompactContainerVersions(versions: readonly GhcrPackageVersion[]): string {
  return versions
    .flatMap((version) => version.metadata?.container?.tags ?? [])
    .join("\n");
}

/** Fetch the versions for each package URL, preserving the input order. */
export async function listDockerContainers(
  urls: readonly string[],
  token: string,
  limit?: number,
): Promise<Map<string, GhcrPackageVersion[]>> {
  const result = new Map<string, GhcrPackageVersion[]>();
  for (const url of urls) {
    result.set(url, await fetchGhcrPackageVersions(url, token, limit));
  }
  return result;
}

/** Ask the user to choose a prebuilt performer tag, or type one manually. */
export async function choosePerformerVersion(sdk: Sdk): Promise<string | undefined> {
  const packageUrl = performerPackageUrl(sdk);
  const token = await resolveGithubToken();

  const askForCustomTag = async (defaultTag: string = sdkDefaultPerformerTag(sdk)): Promise<string | undefined> =>
    normalizePerformerVersion(
      await input({
        promptId: `performer.version.custom.${sdk.value}`,
        message: `Enter the ${sdk.name} performer container tag to use from ${packageUrl}.`,
        default: defaultTag,
        validate: validatePerformerVersion,
      }),
    );

  if (!token) {
    console.warn(
      `\nNo GitHub token found, so fit-cli cannot list ${sdk.name} performer containers from ${packageUrl}.`,
    );
    return askForCustomTag();
  }

  let tags: string[];
  try {
    tags = collectContainerTags(await fetchGhcrPackageVersions(packageUrl, token));
  } catch (err) {
    console.warn(
      `\nCould not list ${sdk.name} performer containers from ${packageUrl}: ${(err as Error).message}`,
    );
    return askForCustomTag();
  }

  if (tags.length === 0) {
    console.warn(`\nNo tagged ${sdk.name} performer containers were returned for ${packageUrl}.`);
    return askForCustomTag();
  }

  const customChoice = "__custom__";
  const preferred = preferredContainerTag(sdk, tags);
  const choice = await select<string>({
    promptId: `performer.version.select.${sdk.value}`,
    message: `Which ${sdk.name} performer container do you want to use?`,
    choices: [
      ...tags.map((tag) => ({
        name: `${performerImageName(sdk, tag)}${tag === preferred ? " (default)" : ""}`,
        value: tag,
      })),
      { name: "Enter my own tag", value: customChoice },
    ],
    default: preferred,
    pageSize: 12,
  });

  if (choice === customChoice) {
    return askForCustomTag(preferred ?? sdkDefaultPerformerTag(sdk));
  }
  return normalizePerformerVersion(choice);
}

function parseCliArgs(argv: string[]): ListDockerContainersCliArgs {
  const args: ListDockerContainersCliArgs = {
    help: false,
    json: false,
    compact: false,
    urls: [],
  };

  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--compact":
        args.compact = true;
        break;
      case "-u":
      case "--url": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--url requires a value.");
        }
        args.urls.push(...value.split(",").map((entry) => entry.trim()).filter(Boolean));
        index++;
        break;
      }
      case "--limit": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--limit requires a value.");
        }
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new Error(`--limit must be a positive integer; got ${JSON.stringify(value)}.`);
        }
        args.limit = parsed;
        index++;
        break;
      }
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        positionals.push(arg);
        break;
    }
  }

  if (args.urls.length > 0 && positionals.length > 0) {
    throw new Error("Pass either a GHCR package URL to list, or an SDK to choose from interactively, not both.");
  }

  if (positionals.length > 1) {
    throw new Error(`Expected at most one SDK positional argument; got ${positionals.join(" ")}.`);
  }

  if (positionals[0]) {
    const sdk = sdkByValue(positionals[0]);
    if (!sdk) {
      throw new Error(`Unknown SDK "${positionals[0]}".`);
    }
    args.sdk = sdk;
  }

  if ((args.json || args.compact || args.limit !== undefined) && args.urls.length === 0) {
    throw new Error("--json, --compact, and --limit are only valid together with --url.");
  }

  return args;
}

async function runListingMode(args: ListDockerContainersCliArgs): Promise<void> {
  const token = await resolveGithubToken();
  if (!token) {
    throw new Error("GITHUB_TOKEN or GH_TOKEN is required to list GHCR container metadata.");
  }

  const versionsByUrl = await listDockerContainers(args.urls, token, args.limit);
  const multi = versionsByUrl.size > 1;

  if (args.json) {
    const payload =
      multi
        ? Object.fromEntries(versionsByUrl.entries())
        : [...versionsByUrl.values()][0] ?? [];
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  for (const [url, versions] of versionsByUrl.entries()) {
    if (multi) {
      console.log("=".repeat(60));
      console.log(url);
      console.log("=".repeat(60));
    }
    console.log(args.compact ? formatCompactContainerVersions(versions) : formatHumanContainerVersions(versions));
  }
}

/** Interactive mini CLI: choose an SDK performer container and print its image ref. */
export async function runChoosePerformerVersion(sdk?: Sdk): Promise<void> {
  const chosenSdk = sdk ?? await chooseSdk("Which SDK performer container do you want to use?");
  const version = await choosePerformerVersion(chosenSdk);
  console.log(performerImageName(chosenSdk, version));
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const args = parseCliArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }
    if (args.urls.length > 0) {
      await runListingMode(args);
      return;
    }
    await runChoosePerformerVersion(args.sdk);
  });
}
