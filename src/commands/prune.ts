import type { GitResult } from "../git/client.js";
import type { PruneTarget } from "../types.js";
import type { CommandOutput } from "./status.js";

export interface PruneRepository {
  resolvePruneTarget(remote?: string): Promise<PruneTarget | undefined>;
  previewPrune(target: PruneTarget): Promise<GitResult>;
  executePrune(target: PruneTarget): Promise<GitResult>;
}

export interface PrunePrompts {
  confirm(options: { message: string; default: false }): Promise<boolean>;
}

export interface PruneOptions {
  repository: PruneRepository;
  prompts: PrunePrompts;
  output: CommandOutput;
  dryRun: boolean;
  interactive: boolean;
  remote?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "ExitPromptError";
}

function redact(value: string, urls: readonly string[]): string {
  return urls.reduce((result, url) => url ? result.replaceAll(url, "<remote>") : result, value);
}

function previewLines(result: GitResult, urls: readonly string[]): string[] {
  return [result.stderr, result.stdout]
    .flatMap((value) => value.split("\n"))
    .filter((line) => line.length > 0 && !line.startsWith("From "))
    .map((line) => redact(line, urls));
}

function writePreview(output: CommandOutput, target: PruneTarget, result: GitResult): void {
  const lines = previewLines(result, target.urls);
  output.out([`Prune preview: ${target.name}`, ...(lines.length === 0 ? ["(no ref changes)"] : lines)].join("\n"));
}

export async function runPrune(options: PruneOptions): Promise<number> {
  let target: PruneTarget | undefined;
  try {
    target = await options.repository.resolvePruneTarget(options.remote);
  } catch (error) {
    options.output.err(messageOf(error));
    return 1;
  }

  if (!target) {
    options.output.out("No remotes are configured.");
    return 0;
  }

  if (!options.dryRun && !options.interactive) {
    options.output.err("Interactive confirmation is required. Use --dry-run to preview safely.");
    return 1;
  }

  let preview: GitResult;
  try {
    preview = await options.repository.previewPrune(target);
  } catch (error) {
    options.output.err(redact(messageOf(error), target.urls));
    return 1;
  }

  writePreview(options.output, target, preview);
  if (options.dryRun) {
    options.output.out("Dry run: no refs were changed.");
    return 0;
  }

  try {
    const confirmed = await options.prompts.confirm({ message: `Apply fetch and prune for '${target.name}'?`, default: false });
    if (!confirmed) {
      options.output.out("No refs were changed.");
      return 0;
    }
  } catch (error) {
    if (isCancellation(error)) {
      options.output.out("No refs were changed.");
      return 0;
    }
    options.output.err(redact(messageOf(error), target.urls));
    return 1;
  }

  try {
    await options.repository.executePrune(target);
    options.output.out(`Pruned remote '${target.name}'.`);
    return 0;
  } catch (error) {
    options.output.err(`Failed to prune remote '${target.name}': ${redact(messageOf(error), target.urls)}`);
    return 1;
  }
}
