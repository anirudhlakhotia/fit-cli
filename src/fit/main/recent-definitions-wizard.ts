/**
 * Wizard flow for picking and acting on a recently generated FIT definition file.
 *
 * bun src/fit/main/recent-definitions-wizard.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { type RunOutput } from "../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { select } from "../../util/non-fit/prompts.js";
import { ensureRunDir } from "../../util/non-fit/replay.js";
import { runFromDefinition } from "../functional/run-from-definition/run-from-definition.js";
import { loadRecentDefinitions, type RecentDefinitionEntry } from "../shared/definition/recent-definitions.js";
import { pushGist } from "../shared/definition/push-gist.js";
import { loadDefinition } from "../shared/definition/parse-definition.js";
import {
  fitDefinitionPath,
  formatFitDefinition,
  type DefinitionFormat,
} from "../shared/definition/generate-definition.js";
import type { InstanceLifetime } from "../shared/definition/types.js";

function formatEntryLabel(entry: RecentDefinitionEntry): string {
  const dt = new Date(entry.createdAt);
  const date = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  const time = `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
  const dir = basename(dirname(entry.path));
  const desc = entry.description.length > 70 ? entry.description.slice(0, 67) + "…" : entry.description;
  return `${date} ${time}  ${desc}  (${dir}/${basename(entry.path)})`;
}

function patchInstanceMode(instance: InstanceLifetime, mode: "localhost" | "aws"): InstanceLifetime {
  const patched = { ...instance } as Record<string, unknown>;
  delete patched.aws;
  delete patched.localhost;
  patched[mode] = {};
  return patched as unknown as InstanceLifetime;
}

async function runInteractive(entry: RecentDefinitionEntry): Promise<RunOutput> {
  const mode = await select<"localhost" | "aws">({
    promptId: "recent.definitions.run.location",
    message: "Where would you like to run?",
    choices: [
      { name: "This machine (localhost)", value: "localhost" },
      { name: "A clean AWS EC2 instance", value: "aws" },
    ],
  });

  const definition = loadDefinition(entry.path);
  const patched = {
    ...definition,
    instances: definition.instances.map((inst) => patchInstanceMode(inst, mode)),
  };

  const format: DefinitionFormat = entry.path.endsWith(".yaml") ? "yaml" : "json5";
  const runDir = ensureRunDir();
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const patchedPath = fitDefinitionPath(runDir, format);
  writeFileSync(patchedPath, formatFitDefinition(patched, format));

  return runFromDefinition(patchedPath);
}

export async function runRecentDefinitionsWizard(goBack?: () => Promise<RunOutput>): Promise<RunOutput> {
  const all = loadRecentDefinitions();
  const entries = all.filter((e) => existsSync(e.path));

  if (entries.length === 0) {
    if (all.length > 0) {
      console.log("No recent definition files found on disk (they may have been cleaned up from /tmp/fit-cli).");
    } else {
      console.log("No recently generated definition files found.  Generate one first via 'Build a FIT definition file'.");
    }
    if (goBack) return goBack();
    return { artifacts: [], details: [] };
  }

  const chosen = await select<RecentDefinitionEntry>({
    promptId: "recent.definitions.choose",
    message: "Choose a recently generated definition file:",
    choices: entries.map((e) => ({ name: formatEntryLabel(e), value: e })),
  });

  const action = await select<"run-direct" | "run-interactive" | "gist-public" | "gist-private">({
    promptId: "recent.definitions.action",
    message: "What would you like to do with it?",
    choices: [
      { name: "Run non-interactively (uses settings from definition file as-is)", value: "run-direct" },
      { name: "Run interactively (choose where to run: localhost or clean cloud instance)", value: "run-interactive" },
      { name: "Push as public gist (for running on CI)", value: "gist-public" },
      { name: "Push as private gist", value: "gist-private" },
    ],
  });

  if (action === "run-direct") {
    return runFromDefinition(chosen.path);
  }

  if (action === "run-interactive") {
    return runInteractive(chosen);
  }

  const content = readFileSync(chosen.path, "utf8");
  const visibility = action === "gist-public" ? "public" : "private";
  console.log(`\nPushing ${visibility} gist…`);
  const gist = await pushGist(chosen.path, content, visibility);
  console.log(`✓ Gist created: ${gist.url}`);
  return { artifacts: [], details: [] };
}

if (isMain(import.meta.url)) {
  runCli(runRecentDefinitionsWizard);
}
