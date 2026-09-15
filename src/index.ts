#!/usr/bin/env node
import { checkbox, confirm } from "@inquirer/prompts";
import { Command, CommanderError } from "commander";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runClean, type CheckboxChoice } from "./commands/clean.js";
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
    .showHelpAfterError()
    .exitOverride();

  program
    .command("status")
    .description("inspect local branch safety")
    .option("--base <branch>", "use an existing local branch as the analysis base")
    .action(async (options: { base?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ base?: string }>();
      process.exitCode = await runStatus(repository(), options.base ?? globals.base, output);
    });

  program
    .command("clean")
    .description("select and safely delete merged local branches")
    .option("--base <branch>", "use an existing local branch as the analysis base")
    .option("--dry-run", "preview every safe deletion candidate without prompting")
    .action(async (options: { base?: string; dryRun?: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ base?: string }>();
      process.exitCode = await runClean({
        repository: repository(),
        base: options.base ?? globals.base,
        dryRun: options.dryRun === true,
        interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
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
