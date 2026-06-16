/**
 * Shared guidance printed after any definition file is generated, telling the
 * user how to run it locally and how to push it to CI via GitHub Gist.
 */
import { definitionExecutePrefix } from "../../../util/non-fit/fit-cli-log.js";

export function definitionRunGuidance(definitionPath: string): string {
  const prefix = definitionExecutePrefix();
  const gistInstructions =
    `\nTo run on CI via https://github.com/couchbaselabs/fit-cli, upload as a gist and trigger:\n` +
    `  GIST_URL=$(gh gist create ${definitionPath} --desc "fit-cli FIT definition")\n` +
    `  echo "Gist: $GIST_URL"\n` +
    `  gh workflow run fit-cli.yaml --repo couchbaselabs/fit-cli --field definitionFile="\${GIST_URL/gist.github.com/gist.githubusercontent.com}/raw"`;

  return (
    `\nRun it later with:\n` +
    `  ${prefix} --interactive ${definitionPath}\n` +
    `\nOr non-interactively (e.g. on CI), taking the default answer to every prompt:\n` +
    `  ${prefix} ${definitionPath}` +
    gistInstructions
  );
}

export function printDefinitionRunGuidance(definitionPath: string): void {
  console.log(definitionRunGuidance(definitionPath));
}
