#!/usr/bin/env node
import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { Command, CommanderError, InvalidArgumentError } from "commander";
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
import type { RepositoryAnalysis } from "./types.js";

interface PackageManifest { version: string }
const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as PackageManifest;

const output: CommandOutput = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`)
};

export type MenuAction = "status" | "clean" | "remote" | "prune" | "remote-clean" | "config" | "exit";
export interface MenuChoice<T> { name: string; value: T }
export const menuChoices: readonly MenuChoice<MenuAction>[] = [
  { name: "Show local status", value: "status" },
  { name: "Clean local branches", value: "clean" },
  { name: "Show remote status", value: "remote" },
  { name: "Prune remote-tracking references", value: "prune" },
  { name: "Clean remote branches", value: "remote-clean" },
  { name: "Show repository configuration", value: "config" },
  { name: "Exit", value: "exit" }
];
export interface MenuOptions {
  repository: { analyze(base?: string): Promise<RepositoryAnalysis>; configuredRemotes(): Promise<string[]> };
  base?: string;
  prompts: {
    action(choices: readonly MenuChoice<MenuAction>[]): Promise<MenuAction>;
    remote(choices: readonly MenuChoice<string>[]): Promise<string>;
  };
  runners: {
    status(base?: string): Promise<number>; clean(base?: string): Promise<number>; remoteStatus(base?: string): Promise<number>;
    prune(remote?: string): Promise<number>; remoteClean(remote: string | undefined, base?: string): Promise<number>; config(): Promise<number>;
  };
  output: CommandOutput;
}

function isCancellation(error: unknown): boolean { return error instanceof Error && error.name === "ExitPromptError"; }
function noAction(menuOutput: CommandOutput): number { menuOutput.out("No action was run."); return 0; }
async function selectMenuRemote(options: MenuOptions): Promise<string | undefined | null> {
  const remotes = [...new Set(await options.repository.configuredRemotes())]
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (remotes.length <= 1) return remotes[0];
  try { return await options.prompts.remote(remotes.map((name) => ({ name, value: name }))); }
  catch (error) { if (isCancellation(error)) return null; throw error; }
}

export async function runMenu(options: MenuOptions): Promise<number> {
  let context: RepositoryAnalysis;
  try { context = await options.repository.analyze(options.base); }
  catch (error) { options.output.err(error instanceof Error ? error.message : String(error)); return 1; }
  options.output.out("Branch Care"); options.output.out("");
  options.output.out(`Repository: ${context.repositoryName}`); options.output.out(`Base branch: ${context.baseBranch}`); options.output.out("");
  let action: MenuAction;
  try { action = await options.prompts.action(menuChoices); }
  catch (error) {
    if (isCancellation(error)) return noAction(options.output);
    options.output.err(error instanceof Error ? error.message : String(error)); return 1;
  }
  try {
    switch (action) {
      case "status": return await options.runners.status(options.base);
      case "clean": return await options.runners.clean(options.base);
      case "remote": return await options.runners.remoteStatus(options.base);
      case "config": return await options.runners.config();
      case "exit": return noAction(options.output);
      case "prune": { const remote = await selectMenuRemote(options); return remote === null ? noAction(options.output) : await options.runners.prune(remote); }
      case "remote-clean": { const remote = await selectMenuRemote(options); return remote === null ? noAction(options.output) : await options.runners.remoteClean(remote, options.base); }
    }
  } catch (error) { options.output.err(error instanceof Error ? error.message : String(error)); return 1; }
}

function repository(): Repository {
  return new Repository(new GitClient(process.cwd()));
}

export function isInteractiveTerminal(stdinIsTTY: boolean | undefined, stdoutIsTTY: boolean | undefined): boolean {
  return stdinIsTTY === true && stdoutIsTTY === true;
}

export function parseOlderThan(value: string): number {
  if (!/^[1-9][0-9]*d$/.test(value)) {
    throw new InvalidArgumentError("must be a positive whole number of days such as 30d");
  }
  const days = Number(value.slice(0, -1));
  if (!Number.isSafeInteger(days)) {
    throw new InvalidArgumentError("must not exceed 9007199254740991d");
  }
  return days;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("branch-care")
    .description("Safely inspect and clean merged local Git branches")
    .version(manifest.version)
    .option("--base <branch>", "use an existing local branch as the analysis base")
    .addHelpText("after", "\nBare invocation: opens a one-shot menu in an interactive terminal; otherwise prints this help\nRepository configuration: .branch-care.json at the Git repository root\nSupported keys: baseBranch, staleAfterDays, protectedBranches")
    .showHelpAfterError()
    .exitOverride()
    .action(async (options: { base?: string }) => {
      if (!isInteractiveTerminal(process.stdin.isTTY, process.stdout.isTTY)) {
        program.outputHelp();
        return;
      }
      const menuRepository = repository();
      process.exitCode = await runMenu({
        repository: menuRepository,
        base: options.base,
        prompts: {
          action: (choices) => select({ message: "What do you want to do?", choices: [...choices] }),
          remote: (choices) => select({ message: "Select a remote:", choices: [...choices] })
        },
        runners: {
          status: (base) => runStatus(menuRepository, base, output),
          clean: (base) => runClean({
            repository: menuRepository,
            base,
            dryRun: false,
            interactive: true,
            prompts: {
              select: (choices: CheckboxChoice[]) => checkbox({ message: "Branches safe to delete:", choices }),
              confirm: (promptOptions) => confirm(promptOptions)
            },
            output
          }),
          remoteStatus: (base) => runRemote(menuRepository, base, output),
          prune: (remote) => runPrune({
            repository: menuRepository,
            remote,
            dryRun: false,
            interactive: true,
            prompts: { confirm: (promptOptions) => confirm(promptOptions) },
            output
          }),
          remoteClean: (remote, base) => runRemoteClean({
            repository: menuRepository,
            base,
            remote,
            dryRun: false,
            interactive: true,
            prompts: {
              select: (choices: CheckboxChoice[]) => checkbox({ message: "Remote branches safe to delete:", choices }),
              confirm: (promptOptions) => confirm(promptOptions),
              input: (promptOptions) => input(promptOptions)
            },
            output
          }),
          config: () => runConfig(menuRepository, undefined, output)
        },
        output
      });
    });

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
    .configureHelp({ helpWidth: 100 })
    .option("--base <branch>", "use an existing local branch as the analysis base")
    .option("--dry-run", "preview every safe deletion candidate without prompting")
    .option("--remote [name]", "delete branches from one remote server instead of locally")
    .option("--older-than <duration>", "only include safe branches at least Nd complete days old", parseOlderThan)
    .action(async (options: { base?: string; dryRun?: boolean; remote?: string | boolean; olderThan?: number }, command: Command) => {
      const globals = command.optsWithGlobals<{ base?: string }>();
      const base = options.base ?? globals.base;
      const interactive = isInteractiveTerminal(process.stdin.isTTY, process.stdout.isTTY);
      if (options.remote !== undefined && options.remote !== false) {
        process.exitCode = await runRemoteClean({
          repository: repository(),
          base,
          remote: typeof options.remote === "string" ? options.remote : undefined,
          dryRun: options.dryRun === true,
          interactive,
          olderThanDays: options.olderThan,
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
        olderThanDays: options.olderThan,
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

if (isMainModule()) {
  await main();
  process.exit(process.exitCode ?? 0);
}
