import {
  PREBUILT_PERFORMER_SDKS,
  sdkByPerformerImageBasename,
  sdkPerformerImageBasename,
  sdkPublishesPerformerImage,
  type Sdk,
} from "../../../util/sdk/sdks.js";

export const GHCR_REGISTRY = "ghcr.io";
export const FIT_PERFORMER_IMAGE_OWNER = "couchbase";
export const JVM_PERFORMER_IMAGE_OWNER = "couchbase";
export const JVM_PERFORMER_PACKAGES_REPOSITORY = "couchbase-jvm-clients";
export const DEFAULT_PERFORMER_IMAGE_TAG = "main";
export const JVM_DEFAULT_PERFORMER_IMAGE_TAG = "main";

/** The default Docker tag used for a given SDK's prebuilt GHCR image. */
export function sdkDefaultPerformerTag(sdk: Sdk): string {
  return sdk.jvm ? JVM_DEFAULT_PERFORMER_IMAGE_TAG : DEFAULT_PERFORMER_IMAGE_TAG;
}

const JVM_SDK_VALUES = new Set(["java", "kotlin", "scala"]);

/** The GHCR package name that holds the prebuilt performer image for this SDK. */
export function performerPackageName(sdk: Sdk): string {
  return `${sdkPerformerImageBasename(sdk)}-fit-performer`;
}

/** The GitHub Packages URL for this SDK's prebuilt performer image. */
export function performerPackageUrl(sdk: Sdk): string {
  const pkg = performerPackageName(sdk);
  if (JVM_SDK_VALUES.has(sdk.value)) {
    return `https://github.com/${JVM_PERFORMER_IMAGE_OWNER}/${JVM_PERFORMER_PACKAGES_REPOSITORY}/pkgs/container/${pkg}`;
  }
  return `https://github.com/orgs/${FIT_PERFORMER_IMAGE_OWNER}/packages/container/package/${pkg}`;
}

/** Normalize a user-supplied tag; blank or the SDK's default tag means "use default". */
export function normalizePerformerVersion(version?: string, sdk?: Sdk): string | undefined {
  const trimmed = version?.trim();
  const defaultTag = sdk ? sdkDefaultPerformerTag(sdk) : DEFAULT_PERFORMER_IMAGE_TAG;
  return !trimmed || trimmed === defaultTag ? undefined : trimmed;
}

/** The Docker tag used for this performer image. */
function performerImageTag(sdk: Sdk, version?: string): string {
  return normalizePerformerVersion(version, sdk) ?? sdkDefaultPerformerTag(sdk);
}

/** The fully-qualified GHCR image reference fit-cli pulls and runs for this performer. */
export function performerImageName(sdk: Sdk, version?: string): string {
  const owner = JVM_SDK_VALUES.has(sdk.value) ? JVM_PERFORMER_IMAGE_OWNER : FIT_PERFORMER_IMAGE_OWNER;
  return `${GHCR_REGISTRY}/${owner}/${performerPackageName(sdk)}:${performerImageTag(sdk, version)}`;
}

/**
 * The short image reference stored in definition files: `<sdk>-fit-performer:<tag>`
 * (e.g. `java-fit-performer:main`). fit-cli prepends the GHCR registry/owner at
 * run time via {@link performerImageName}.
 */
export function performerImageShortName(sdk: Sdk, tag: string = sdkDefaultPerformerTag(sdk)): string {
  return `${performerPackageName(sdk)}:${tag.trim() || sdkDefaultPerformerTag(sdk)}`;
}

export interface ParsedPerformerImage {
  sdk: Sdk;
  tag: string;
}

// Accepts the short form `<sdk>-fit-performer:<tag>` and the fully-qualified
// `ghcr.io/<owner>/<sdk>-fit-performer:<tag>` (the owner prefix is fit-cli's to
// derive, so it's accepted but discarded).
const PERFORMER_IMAGE_PATTERN =
  /^(?:ghcr\.io\/[^/]+\/)?(?<sdk>[a-z0-9]+)-fit-performer:(?<tag>[A-Za-z0-9_][A-Za-z0-9._-]{0,127})$/;

/** Parse a performer image into its SDK and tag, or return why it isn't valid. */
export function analysePerformerImage(image: string): ParsedPerformerImage | { error: string } {
  const trimmed = image.trim();
  if (!trimmed) {
    return { error: "Performer image cannot be blank. Use <sdk>-fit-performer:<tag>, e.g. java-fit-performer:main." };
  }
  const match = PERFORMER_IMAGE_PATTERN.exec(trimmed);
  if (!match?.groups) {
    return {
      error:
        `Performer image must look like <sdk>-fit-performer:<tag> (e.g. java-fit-performer:main` +
        ` or java-fit-performer:refs-changes-18-195818-7); got ${JSON.stringify(image)}.`,
    };
  }
  const sdk = sdkByPerformerImageBasename(match.groups.sdk);
  if (!sdk) {
    const supported = PREBUILT_PERFORMER_SDKS.map((s) => `${sdkPerformerImageBasename(s)} (${s.name})`).join(", ");
    return {
      error:
        `Unknown SDK "${match.groups.sdk}" in performer image ${JSON.stringify(image)}.` +
        ` Supported image prefixes: ${supported}.`,
    };
  }
  if (!sdkPublishesPerformerImage(sdk)) {
    return {
      error:
        `Only the JVM SDKs (java, scala, kotlin), C++ (cxx) and .NET (dotnet) publish prebuilt performer` +
        ` images, and ${sdk.name} (${sdk.value}) does not. Pick one of those SDKs.`,
    };
  }
  return { sdk, tag: match.groups.tag };
}

/** Parse a performer image into its SDK and tag, throwing if it isn't valid. */
export function parsePerformerImage(image: string): ParsedPerformerImage {
  const result = analysePerformerImage(image);
  if ("error" in result) {
    throw new Error(result.error);
  }
  return result;
}

/** Validate a manually-entered performer tag (not a full image reference). */
export function validatePerformerVersion(value: string): true | string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Enter a tag like main or 4.2.0.";
  }
  if (/\s/.test(trimmed)) {
    return "Docker tags cannot contain whitespace.";
  }
  if (trimmed.includes("/") || trimmed.includes(":") || trimmed.includes("@")) {
    return "Enter only the image tag, not a full image reference.";
  }
  return true;
}
