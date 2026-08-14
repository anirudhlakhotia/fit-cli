/**
 * Step: warn (but don't block) when running on a platform we haven't tested.
 *
 * Run on its own:
 *   bun src/fit/main/check-platform.ts
 *
 * Always exits 0 - this is a warning, not a gate. Pass --platform to simulate
 * a different platform for testing, e.g. --platform win32.
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";

const UNTESTED_PLATFORMS: Record<string, string> = {
  win32: "Windows",
};

// process.platform's known values (NodeJS.Platform), used to reject typos
// like "windows" in the --platform CLI flag rather than silently no-op-ing.
const KNOWN_PLATFORMS = [
  "aix", "android", "darwin", "freebsd", "haiku", "linux",
  "openbsd", "sunos", "win32", "cygwin", "netbsd",
];

export function warningBox(platformName: string): string {
  const lines = [
    `WARNING: FIT CLI has not been tested on ${platformName}.`,
    "Things may not work as expected. Contributions are welcome!",
  ];
  const width = Math.max(...lines.map((l) => l.length));
  const pad = (l: string) => `║  ${l.padEnd(width)}  ║`;
  return (
    `╔${"═".repeat(width + 4)}╗\n` +
    lines.map(pad).join("\n") + "\n" +
    `╚${"═".repeat(width + 4)}╝\n`
  );
}

export function checkPlatform(platform: string = process.platform): void {
  const platformName = UNTESTED_PLATFORMS[platform];
  if (platformName) {
    console.warn(warningBox(platformName));
  }
}

if (isMain(import.meta.url)) {
  // eslint-disable-next-line @typescript-eslint/require-await -- runCli requires an async callback; checkPlatform itself is synchronous
  runCli(async () => {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
      console.log(
        "Usage: bun src/fit/main/check-platform.ts [--platform <platform>]\n\n" +
          `Prints a warning if the given (or current) platform is untested. Never exits non-zero.\n` +
          `Valid --platform values (Node's process.platform): ${KNOWN_PLATFORMS.join(", ")}`,
      );
      return;
    }
    const flagIndex = args.indexOf("--platform");
    const platform = flagIndex !== -1 ? args[flagIndex + 1] : process.platform;
    if (!KNOWN_PLATFORMS.includes(platform)) {
      throw new Error(
        `Unknown --platform "${platform}". Valid values (Node's process.platform): ${KNOWN_PLATFORMS.join(", ")}`,
      );
    }
    checkPlatform(platform);
  });
}
