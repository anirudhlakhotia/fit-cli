/**
 * SDKs that FIT can test.
 *
 * `performer` is the SDK's performer directory name. For non-JVM SDKs that is
 * the directory under transactions-fit-performer/performers. For JVM SDKs
 * (Java, Kotlin, Scala) the performer lives in couchbase-jvm-clients as
 * <performer>-fit-performer; the matching performers/ entry under
 * transactions-fit-performer is the old one and is no longer used.
 */
export const SDKS = [
  { name: "Java", value: "java", jvm: true, performer: "java" },
  { name: "Scala", value: "scala", jvm: true, performer: "scala" },
  { name: "Kotlin", value: "kotlin", jvm: true, performer: "kotlin" },
  { name: "C++", value: "cpp", jvm: false, performer: "cpp" },
  { name: ".NET", value: "dotnet", jvm: false, performer: "dotnet" },
  { name: "Go", value: "go", jvm: false, performer: "go" },
  { name: "Node.js", value: "node", jvm: false, performer: "node" },
  { name: "Python", value: "python", jvm: false, performer: "python" },
  { name: "Ruby", value: "ruby", jvm: false, performer: "ruby" },
  { name: "Rust", value: "rust", jvm: false, performer: "rust" },
] as const;

export type Sdk = (typeof SDKS)[number];
export type SdkValue = Sdk["value"];

/** Look up an SDK by its `value`, or undefined if there is no such SDK. */
export function sdkByValue(value: string): Sdk | undefined {
  return SDKS.find((sdk) => sdk.value === value);
}

/**
 * True if this SDK currently publishes a prebuilt performer Docker image to
 * GHCR. Only the JVM SDKs (Java, Scala, Kotlin), C++ and .NET do today, and
 * fit-cli only runs performers from prebuilt images, so these are the only SDKs
 * it can test.
 */
export function sdkPublishesPerformerImage(sdk: Sdk): boolean {
  return sdk.jvm || sdk.value === "cpp" || sdk.value === "dotnet";
}

/** The SDKs fit-cli can test — those with prebuilt performer images (JVM + C++ + .NET). */
export const PREBUILT_PERFORMER_SDKS = SDKS.filter(sdkPublishesPerformerImage);

/**
 * The GHCR package basename for an SDK's performer image is usually its `value`
 * (e.g. `java` → `java-fit-performer`), but a few differ from the SDK's value.
 * C++ uses `value` "cpp" everywhere user-facing but publishes `cxx-fit-performer`.
 */
const PERFORMER_IMAGE_BASENAMES: Partial<Record<SdkValue, string>> = { cpp: "cxx" };

/** The basename of this SDK's GHCR performer image (before `-fit-performer`). */
export function sdkPerformerImageBasename(sdk: Sdk): string {
  return PERFORMER_IMAGE_BASENAMES[sdk.value] ?? sdk.value;
}

/** Look up an SDK by its performer image basename (e.g. `cxx` → C++), or undefined. */
export function sdkByPerformerImageBasename(basename: string): Sdk | undefined {
  return SDKS.find((sdk) => sdkPerformerImageBasename(sdk) === basename);
}
