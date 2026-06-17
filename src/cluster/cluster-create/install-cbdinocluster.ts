/**
 * Step: install cbdinocluster on a remote box by downloading the matching binary
 * straight from the couchbaselabs/cbdinocluster GitHub releases, rather than
 * scp-ing up whatever happens to be on *this* machine (which couples the remote
 * to the local OS/arch and to the operator having cbdinocluster installed at
 * all). It detects the remote's OS/arch, fetches the latest release asset, makes
 * it executable, and returns the absolute path it landed at — ready to hand to
 * `cbdinocluster <args>` over the same executor.
 *
 * The whole thing runs as one remote shell script so it works through any
 * executor that can `capture` a command (a {@link RemoteTarget} for the
 * standalone CLI below, or a remote FitExecutionContext for setup-cluster).
 *
 * Run on its own against an existing EC2 instance (installs, does not allocate
 * anything):
 *   # Using a saved instance dir (reads ec2-instance.json + .pem automatically):
 *   npx tsx src/cluster/cluster-create/install-cbdinocluster.ts --dir /tmp/fit-cli/<run>/instances/0
 *   # With explicit flags:
 *   npx tsx src/cluster/cluster-create/install-cbdinocluster.ts \
 *     --instance i-0123456789abcdef0 --key ~/.ssh/my-key.pem [--user ubuntu] [--region eu-west-1]
 */
import { readFileSync } from "fs";
import { join } from "path";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { prepareAwsCli } from "../../cloud/util/aws/aws-cli.js";
import { AWS_REGION } from "../../cloud/util/aws/aws-target.js";
import { describeInstance } from "../../cloud/util/aws/describe-instance.js";
import { RemoteTarget } from "../../util/non-fit/remote-target.js";
import { waitForSsh, type RemoteHost } from "../../util/non-fit/ssh.js";
import type { RunOptions } from "../../util/non-fit/proc.js";
import { fitCliError } from "../../util/non-fit/fit-cli-log.js";
import { CBDINOCLUSTER_URL } from "../../fit/util/config.js";

/** Default login user for the EC2 boxes fit-cli launches (stock Ubuntu AMI). */
const DEFAULT_INSTANCE_USER = "ubuntu";

/** Where the remote install drops the binary (a per-user dir that needs no sudo). */
const DEFAULT_REMOTE_BIN_DIR = "$HOME/.local/bin";

/** The minimum an executor must offer for {@link installCbdinoclusterRemote}. */
export type CaptureExecutor = {
  readonly description: string;
  capture(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<string>;
};

/**
 * The shell script that runs on the remote host to install cbdinocluster. It
 * maps `uname` output to the release asset naming (`cbdinocluster-<os>-<arch>`),
 * downloads the latest release with curl (`-f` so a bad URL is a hard failure),
 * makes it executable, and finally prints the absolute path it installed to so
 * the caller can parse it back. `set -e` means any step failing aborts.
 */
export function remoteInstallScript(binDir: string = DEFAULT_REMOTE_BIN_DIR): string {
  return [
    "set -e",
    `os=$(uname -s | tr '[:upper:]' '[:lower:]')`,
    "arch=$(uname -m)",
    'case "$arch" in',
    "  x86_64|amd64) arch=amd64 ;;",
    "  aarch64|arm64) arch=arm64 ;;",
    '  *) echo "cbdinocluster: unsupported architecture $arch" >&2; exit 1 ;;',
    "esac",
    `bindir="${binDir}"`,
    'mkdir -p "$bindir"',
    'target="$bindir/cbdinocluster"',
    `url="${CBDINOCLUSTER_URL}/releases/latest/download/cbdinocluster-$os-$arch"`,
    'curl -fsSL "$url" -o "$target"',
    'chmod 755 "$target"',
    // The one line of stdout the caller parses: the absolute path it installed to.
    `printf '%s\\n' "$target"`,
  ].join("\n");
}

/**
 * Install the latest cbdinocluster release on the host `execution` runs on, and
 * resolve with the absolute path to the installed binary. Throws (via the
 * executor) if the download or install fails, or if nothing usable came back.
 */
export async function installCbdinoclusterRemote(
  execution: CaptureExecutor,
  binDir: string = DEFAULT_REMOTE_BIN_DIR,
): Promise<string> {
  console.log(
    `→ Installing the latest cbdinocluster release on ${execution.description} from ${CBDINOCLUSTER_URL}...`,
  );
  const output = await execution.capture("sh", ["-lc", remoteInstallScript(binDir)], undefined, {
    display: `install cbdinocluster from ${CBDINOCLUSTER_URL}`,
  });
  const installedPath = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  if (!installedPath) {
    throw new Error("cbdinocluster install script didn't print where it installed the binary");
  }
  console.log(`✓ Installed cbdinocluster on ${execution.description} at ${installedPath}`);
  return installedPath;
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

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    let instanceId = flag(argv, "instance");
    let identityFile = flag(argv, "key");
    let address: string | undefined;
    const user = flag(argv, "user") ?? DEFAULT_INSTANCE_USER;

    const instanceDir = flag(argv, "dir");
    if (instanceDir) {
      const info = JSON.parse(readFileSync(join(instanceDir, "ec2-instance.json"), "utf8")) as {
        instanceId?: string;
        keyPath?: string;
        address?: string;
      };
      instanceId ??= info.instanceId;
      identityFile ??= info.keyPath;
      address = info.address;
    }

    if (!instanceId || !identityFile) {
      fitCliError(
        "Usage:\n" +
          "  install-cbdinocluster.ts --dir <instance-dir> [--user ubuntu]\n" +
          "  install-cbdinocluster.ts --instance <ec2-id> --key <path.pem> [--user ubuntu]",
      );
      process.exit(1);
    }

    if (!address) {
      await prepareAwsCli();
      console.log(`Looking up EC2 instance ${instanceId}...`);
      const info = await describeInstance(instanceId);
      if (!info) {
        throw new Error(`No EC2 instance found with id ${instanceId} (in ${AWS_REGION}).`);
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
    const installedPath = await installCbdinoclusterRemote(target);

    // Sanity-check the binary actually runs on this box (catches an OS/arch
    // mismatch, which would otherwise only surface later as "Exec format error").
    await target.capture(installedPath, ["--help"]);
    console.log(`\n✓ cbdinocluster is ready on ${instanceId} (${user}@${address}) at ${installedPath}`);

    return {
      details: [
        { label: "Instance", value: `${instanceId} (${user}@${address})` },
        { label: "cbdinocluster path", value: installedPath },
        { label: "SSH debug command", value: `ssh -i ${identityFile} ${user}@${address}` },
      ],
    };
  });
}
