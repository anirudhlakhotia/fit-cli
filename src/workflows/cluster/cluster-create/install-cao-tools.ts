/**
 * Step: install the Couchbase Autonomous Operator (cao) tools on a remote box,
 * replicating what `cbdinocluster init` does interactively. cbdinocluster only
 * downloads the cao tools behind an interactive `auto-install the cao tools?
 * [Y/n]` prompt, which never fires on the non-interactive remote runs fit-cli
 * drives — so without this the configured `cao-tools` directory stays empty and a
 * CNG allocation fails later when cbdinocluster goes looking for `cao` there.
 *
 * The work is one remote shell script (see {@link caoToolsInstallScript}) so it
 * runs through any executor that can `run` a command — a {@link RemoteTarget} for
 * the standalone CLI below, or the cluster executor that setup-cluster already
 * uses for {@link provisionRemoteK3d}.
 *
 * Run on its own:
 *   # Just print the script it would run (no SSH, no AWS):
 *   npx tsx src/workflows/cluster/cluster-create/install-cao-tools.ts --print [--cao-dir <path>] [--version 2.8.0]
 *   # Install using a saved instance dir (reads ec2-instance.json + .pem automatically):
 *   npx tsx src/workflows/cluster/cluster-create/install-cao-tools.ts --dir /tmp/fit-cli/<run>/instances/0
 *   # Install with explicit flags:
 *   npx tsx src/workflows/cluster/cluster-create/install-cao-tools.ts \
 *     --instance i-0123456789abcdef0 --key ~/.ssh/my-key.pem [--user ubuntu] [--region eu-west-1] [--version 2.8.0]
 */
import { readFileSync } from "fs";
import { join } from "path";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { prepareAwsCli } from "../../../util/non-fit/aws/aws-cli.js";
import { describeInstance } from "../../../util/non-fit/aws/describe-instance.js";
import { fitCliError } from "../../../util/non-fit/fit-cli-log.js";
import type { RunOptions } from "../../../util/non-fit/proc.js";
import { posixQuote, RemoteTarget } from "../../../util/non-fit/remote-target.js";
import { waitForSsh, type RemoteHost } from "../../../util/non-fit/ssh.js";

/** The Couchbase Autonomous Operator tools version CNG uses (matches the cao block). */
export const CAO_TOOLS_VERSION = "2.8.0";

/** Where Couchbase publishes the Autonomous Operator (cao) release tarballs. */
export const CAO_TOOLS_DOWNLOAD_BASE = "https://packages.couchbase.com/releases/couchbase-operator";

/** Default login user for the EC2 boxes fit-cli launches (stock Ubuntu AMI). */
const DEFAULT_INSTANCE_USER = "ubuntu";

/** The minimum an executor must offer for {@link installCaoToolsRemote}. */
export type RunExecutor = {
  readonly description: string;
  run(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<void>;
};

/**
 * The shell script that installs the cao tools into `caoToolsDir`, replicating
 * what `cbdinocluster init` does interactively: download the release tarball
 * matching the box's arch, extract it, and move its contents to the final
 * location (so cbdinocluster finds `cao` exactly where it expects).
 *
 * Idempotent: skips the download when `caoToolsDir` already has contents, so a
 * resumed run on the same box is a no-op. Pure logic. `set -e` aborts on any
 * step failing.
 */
export function caoToolsInstallScript(
  caoToolsDir: string,
  version: string = CAO_TOOLS_VERSION,
): string {
  return [
    "set -e",
    `dest=${posixQuote(caoToolsDir)}`,
    // Already populated (e.g. a resumed run)? Nothing to do.
    'if [ -d "$dest" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ]; then',
    `  printf '%s\\n' "cao tools already present at $dest"`,
    "  exit 0",
    "fi",
    "arch=$(uname -m)",
    'case "$arch" in',
    "  x86_64|amd64) arch=amd64 ;;",
    "  aarch64|arm64) arch=arm64 ;;",
    '  *) echo "cao: unsupported architecture $arch" >&2; exit 1 ;;',
    "esac",
    `ver=${posixQuote(version)}`,
    `url="${CAO_TOOLS_DOWNLOAD_BASE}/$ver/couchbase-autonomous-operator_$ver-kubernetes-linux-$arch.tar.gz"`,
    "tmp=$(mktemp -d)",
    `trap 'rm -rf "$tmp"' EXIT`,
    'curl -fsSL "$url" -o "$tmp/cao.tar.gz"',
    'tar -xzf "$tmp/cao.tar.gz" -C "$tmp"',
    // The tarball holds a single top-level dir; move its contents into dest so
    // cbdinocluster finds cao exactly where it expects (mirrors its own move).
    `extracted=$(find "$tmp" -maxdepth 1 -mindepth 1 -type d | head -n1)`,
    'mkdir -p "$dest"',
    'cp -R "$extracted"/. "$dest"/',
    `printf '%s\\n' "installed cao tools to $dest"`,
  ].join("\n");
}

/**
 * Install the cao tools into `caoToolsDir` on the host `execution` runs on, and
 * resolve with that directory. Throws (via the executor) if the download or
 * install fails. Idempotent by way of {@link caoToolsInstallScript}.
 */
export async function installCaoToolsRemote(
  execution: RunExecutor,
  caoToolsDir: string,
  version: string = CAO_TOOLS_VERSION,
): Promise<string> {
  console.log(`→ Installing cao tools (${version}) into ${caoToolsDir} on ${execution.description}…`);
  await execution.run("sh", ["-lc", caoToolsInstallScript(caoToolsDir, version)], undefined, {
    display: `install cao tools ${version}`,
  });
  return caoToolsDir;
}

/** Read a `--<name> <value>` (or `--<name>=<value>`) flag from argv. */
function flag(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) {
      return argv[i + 1];
    }
    if (argv[i].startsWith(prefix)) {
      return argv[i].slice(prefix.length);
    }
  }
  return undefined;
}

/** The cao-tools dir for a login user, mirroring the remote `k8s` block layout. */
function defaultCaoToolsDir(user: string, version: string): string {
  return `/home/${user}/.dinotools/cao/${version}`;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    const version = flag(argv, "version") ?? CAO_TOOLS_VERSION;

    // --print just emits the script (no SSH, no AWS) — handy for inspection.
    if (argv.includes("--print")) {
      const dir = flag(argv, "dir") ?? defaultCaoToolsDir(DEFAULT_INSTANCE_USER, version);
      console.log(caoToolsInstallScript(dir, version));
      return;
    }

    let instanceId = flag(argv, "instance");
    let identityFile = flag(argv, "key");
    let address: string | undefined;
    const user = flag(argv, "user") ?? DEFAULT_INSTANCE_USER;

    const instanceDir = flag(argv, "dir");
    if (instanceDir) {
      const info = JSON.parse(readFileSync(join(instanceDir, "ec2-instance.json"), "utf8"));
      instanceId ??= info.instanceId;
      identityFile ??= info.keyPath;
      address = info.address;
    }

    if (!instanceId || !identityFile) {
      fitCliError(
        "Usage:\n" +
          "  install-cao-tools.ts --dir <instance-dir> [--user ubuntu] [--version 2.8.0] [--cao-dir <cao-tools-dir>]\n" +
          "  install-cao-tools.ts --instance <ec2-id> --key <path.pem> [--user ubuntu] [--region <aws-region>] [--version 2.8.0] [--cao-dir <cao-tools-dir>]\n" +
          "  install-cao-tools.ts --print [--cao-dir <cao-tools-dir>] [--version 2.8.0]",
      );
      process.exit(1);
    }
    const caoToolsDir = flag(argv, "cao-dir") ?? defaultCaoToolsDir(user, version);

    if (!address) {
      const awsOptions = await prepareAwsCli(argv);
      console.log(`Looking up EC2 instance ${instanceId}...`);
      const info = await describeInstance(instanceId, awsOptions);
      if (!info) {
        throw new Error(`No EC2 instance found with id ${instanceId} (in ${awsOptions.region}).`);
      }
      address = info.publicDns || info.publicIp;
      if (!address) {
        throw new Error(`Instance ${instanceId} is ${info.state} and has no public address to SSH to.`);
      }
    }

    const host: RemoteHost = { host: address, user, identityFile };
    process.stdout.write(`Connecting to ${user}@${address} over SSH...`);
    if (!(await waitForSsh(host))) {
      console.log(" unreachable");
      throw new Error(`Couldn't reach ${user}@${address} over SSH. Check the key, user, and that the box is up.`);
    }
    console.log(" ready");

    const target = new RemoteTarget(host);
    await installCaoToolsRemote(target, caoToolsDir, version);
    console.log(`\n✓ cao tools (${version}) are ready on ${instanceId} (${user}@${address}) at ${caoToolsDir}`);

    return {
      details: [
        { label: "Instance", value: `${instanceId} (${user}@${address})` },
        { label: "cao tools dir", value: caoToolsDir },
        { label: "SSH debug command", value: `ssh -i ${identityFile} ${user}@${address}` },
      ],
    };
  });
}
