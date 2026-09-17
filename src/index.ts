#!/usr/bin/env node
import { checkbox, confirm, input } from "@inquirer/prompts";
import { Command, CommanderError } from "commander";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runClean, type CheckboxChoice } from "./commands/clean.js";
import { runConfig } from "./commands/config.js";
import { runPrune } from "./commands/prune.js";
import { runRemoteClean } from "./commands/remote-clean.js";
import { runRemote } from "./commands/remote.js";
import { runStatus, type CommandOutput } from "./commands/status.js";
import { GitClient } from "./git/client.js";
import { Repository } from "./git/repository.js";

interface PackageManifest { version: string }
const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as PackageManifest;

const output: CommandOutput = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`)
};

function repository(): Repository {
  return new Repository(new GitClient(process.cwd()));
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("branch-care")
    .description("Safely inspect and clean merged local Git branches")
    .version(manifest.version)
    .option("--base <branch>", "use an existing local branch as the analysis base")
    .addHelpText("after", "\nRepository configuration: .branch-care.json at the Git repository root\nSupported keys: baseBranch, staleAfterDays, protectedBranches")
    .showHelpAfterError()
    .exitOverride();

  program
    .command("status")
    .description("inspect local branch safety")
    .option("--base <branch>", "use an existing local branch as the analysis base")
    .option("--json", "print versioned machine-readable output")
    .action(async (options: { base?: string; json?: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ base?: string }>();
      process.exitCode = await runStatus(repository(), options.base ?? globals.base, output, options.json === true);
    });

  program
    .command("remote")
    .description("inspect locally known remote branches")
    .option("--base <branch>", "use an existing local branch as the analysis base")
    .action(async (options: { base?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ base?: string }>();
      process.exitCode = await runRemote(repository(), options.base ?? globals.base, output);
    });

  program
    .command("prune")
    .description("fetch and prune local remote-tracking refs over the network")
    .option("--remote <name>", "select one configured remote")
    .option("--dry-run", "preview network fetch and prune without changing refs")
    .action(async (options: { remote?: string; dryRun?: boolean }) => {
      process.exitCode = await runPrune({
        repository: repository(),
        remote: options.remote,
        dryRun: options.dryRun === true,
        interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
        prompts: { confirm: (options) => confirm(options) },
        output
      });
    });

  program
    .command("config")
    .description("inspect or update repository .branch-care.json configuration")
    .option("--base <branch>", "set baseBranch to an existing local branch")
    .addHelpText("after", "\nRepository file: .branch-care.json\nSupported keys: baseBranch, staleAfterDays, protectedBranches")
    .action(async (options: { base?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ base?: string }>();
      process.exitCode = await runConfig(repository(), options.base ?? globals.base, output);
    });

  program
    .command("clean")
    .description("select and safely delete merged branches locally by default")
    .option("--base <branch>", "use an existing local branch as the analysis base")
    .option("--dry-run", "preview every safe deletion candidate without prompting")
    .option("--remote [name]", "delete branches from one remote server instead of locally")
    .action(async (options: { base?: string; dryRun?: boolean; remote?: string | boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ base?: string }>();
      const base = options.base ?? globals.base;
      const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
      if (options.remote !== undefined && options.remote !== false) {
        process.exitCode = await runRemoteClean({
          repository: repository(),
          base,
          remote: typeof options.remote === "string" ? options.remote : undefined,
          dryRun: options.dryRun === true,
          interactive,
          prompts: {
            select: (choices: CheckboxChoice[]) => checkbox({ message: "Remote branches safe to delete:", choices }),
            confirm: (options) => confirm(options),
            input: (options) => input(options)
          },
          output
        });
        return;
      }
      process.exitCode = await runClean({
        repository: repository(),
        base,
        dryRun: options.dryRun === true,
        interactive,
        prompts: {
          select: (choices: CheckboxChoice[]) => checkbox({ message: "Branches safe to delete:", choices }),
          confirm: (options) => confirm(options)
        },
        output
      });
    });

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  const program = createProgram();
  try {
    if (argv.length <= 2) {
      program.outputHelp();
      return;
    }
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode !== 0) process.exitCode = 2;
      return;
    }
    output.err(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) await main();
