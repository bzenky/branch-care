import type { GitResult } from "../git/client.js";
import type { RemoteDeleteAnalysis, RemoteDeleteCandidate, RemoteDeleteTarget } from "../types.js";
import { sortBranches } from "../ui/output.js";
import type { CheckboxChoice } from "./clean.js";
import type { CommandOutput } from "./status.js";

export interface RemoteCleanRepository {
  resolveRemoteDeletionTarget(remote?: string): Promise<RemoteDeleteTarget | undefined>;
  analyzeRemoteDeletion(remote?: string, base?: string): Promise<RemoteDeleteAnalysis>;
  revalidateRemoteDeletion(remote: string, selected: readonly RemoteDeleteCandidate[], base?: string): Promise<RemoteDeleteCandidate[]>;
  deleteRemoteBranches(remote: string, candidates: readonly RemoteDeleteCandidate[]): Promise<GitResult>;
}

export interface RemoteCleanPrompts {
  select(options: CheckboxChoice[]): Promise<string[]>;
  confirm(options: { message: string; default: false }): Promise<boolean>;
  input(options: { message: string }): Promise<string>;
}

export interface RemoteCleanOptions {
  repository: RemoteCleanRepository;
  prompts: RemoteCleanPrompts;
  output: CommandOutput;
  dryRun: boolean;
  interactive: boolean;
  remote?: string;
  base?: string;
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

function noOp(options: RemoteCleanOptions): number {
  options.output.out("No remote branches were removed.");
  return 0;
}

export async function runRemoteClean(options: RemoteCleanOptions): Promise<number> {
  let target: RemoteDeleteTarget | undefined;
  try {
    target = await options.repository.resolveRemoteDeletionTarget(options.remote);
  } catch (error) {
    options.output.err(messageOf(error));
    return 1;
  }
  if (!target) {
    options.output.out("No remotes are configured.");
    return 0;
  }
  if (!options.dryRun && !options.interactive) {
    options.output.err("Interactive remote selection is required. Use --dry-run to preview safely.");
    return 1;
  }

  let analysis: RemoteDeleteAnalysis;
  try {
    analysis = await options.repository.analyzeRemoteDeletion(target.name, options.base);
  } catch (error) {
    options.output.err(redact(messageOf(error), target.urls));
    return 1;
  }
  if (analysis.candidates.length === 0) {
    options.output.out("No remote branches are safe to delete.");
    return 0;
  }

  const candidateNames = sortBranches([...new Set(analysis.candidates.map(({ fullName }) => fullName))]);
  if (options.dryRun) {
    options.output.out([
      "Remote dry run", `Remote: ${analysis.remote}`, "", "Would delete from server:",
      ...candidateNames, "", "No remote branches were removed."
    ].join("\n"));
    return 0;
  }

  try {
    const selectedNames = sortBranches([...new Set(await options.prompts.select(candidateNames.map((name) => ({
      name, value: name, checked: false
    }))))]);
    if (selectedNames.length === 0) return noOp(options);
    const selected = selectedNames.map((name) => analysis.candidates.find(({ fullName }) => fullName === name)!);

    options.output.out("Selected remote branches:");
    for (const name of selectedNames) options.output.out(name);
    options.output.out(`Total: ${selectedNames.length}`);

    const confirmed = await options.prompts.confirm({
      message: `Delete ${selectedNames.length} ${selectedNames.length === 1 ? "branch" : "branches"} from '${analysis.remote}'?`,
      default: false
    });
    if (!confirmed) return noOp(options);
    const typedRemote = await options.prompts.input({ message: `Type '${analysis.remote}' to confirm remote deletion:` });
    if (typedRemote !== analysis.remote) return noOp(options);

    let revalidated: RemoteDeleteCandidate[];
    try {
      revalidated = await options.repository.revalidateRemoteDeletion(analysis.remote, selected, options.base);
    } catch (error) {
      options.output.err(`Remote deletion skipped: ${redact(messageOf(error), analysis.urls)}`);
      return 1;
    }

    try {
      await options.repository.deleteRemoteBranches(analysis.remote, revalidated);
    } catch (error) {
      options.output.err(`Remote deletion failed: ${redact(messageOf(error), analysis.urls)}`);
      return 1;
    }

    for (const { fullName } of revalidated) options.output.out(`Deleted ${fullName}`);
    options.output.out(`Deleted ${revalidated.length} remote ${revalidated.length === 1 ? "branch" : "branches"}.`);
    return 0;
  } catch (error) {
    if (isCancellation(error)) return noOp(options);
    options.output.err(redact(messageOf(error), analysis.urls));
    return 1;
  }
}
