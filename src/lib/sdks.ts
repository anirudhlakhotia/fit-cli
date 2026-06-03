/**
 * SDKs that FIT can test. The JVM-based ones share couchbase-jvm-clients and
 * the single "java" performer. `performer` is the SDK's directory under
 * transactions-fit-performer/performers.
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
