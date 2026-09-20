import type { GitResult } from "../git/client.js";
import type { RemoteDeleteAnalysis, RemoteDeleteCandidate, RemoteDeleteTarget } from "../types.js";
import { sortBranches } from "../ui/output.js";
import type { CheckboxChoice } from "./clean.js";
import type { CommandOutput } from "./status.js";
import type { UndoHistory, UndoReceipt } from "../undo-history.js";

export interface RemoteCleanRepository {
  resolveRemoteDeletionTarget(remote?: string): Promise<RemoteDeleteTarget | undefined>;
  analyzeRemoteDeletion(remote?: string, base?: string, olderThanDays?: number): Promise<RemoteDeleteAnalysis>;
  revalidateRemoteDeletion(target: RemoteDeleteTarget, selected: readonly RemoteDeleteCandidate[], base?: string, olderThanDays?: number): Promise<RemoteDeleteCandidate[]>;
  deleteRemoteBranches(destination: string, candidates: readonly RemoteDeleteCandidate[]): Promise<GitResult>;
  remoteHeadOids?(destination: string): Promise<Map<string, string>>;
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
  olderThanDays?: number;
  history?: UndoHistory;
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
  let lock: Awaited<ReturnType<UndoHistory["acquire"]>> | undefined;
  try {
    if (options.history && !options.dryRun) { lock = await options.history.acquire(); await options.history.reconcilePending((endpoint) => options.repository.remoteHeadOids ? options.repository.remoteHeadOids(endpoint) : Promise.reject(new Error("Remote inventory is unavailable."))); if (!(await options.history.assertCapacity(false, options.output))) return 1; }
  } catch (error) { options.output.err(messageOf(error)); return 1; }
  try {
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
  if (options.history && options.dryRun) {
    try { await options.history.assertCapacity(true, options.output); }
    catch (error) { options.output.err(messageOf(error)); return 1; }
  }
  if (!options.dryRun && !options.interactive) {
    options.output.err("Interactive remote selection is required. Use --dry-run to preview safely.");
    return 1;
  }

  let analysis: RemoteDeleteAnalysis;
  try {
    analysis = await options.repository.analyzeRemoteDeletion(target.name, options.base, options.olderThanDays);
  } catch (error) {
    options.output.err(redact(messageOf(error), target.urls));
    return 1;
  }
  if (options.olderThanDays !== undefined) options.output.out(`Older than: ${options.olderThanDays}d`);
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
      revalidated = await options.repository.revalidateRemoteDeletion(target, selected, options.base, options.olderThanDays);
    } catch (error) {
      options.output.err(`Remote deletion skipped: ${redact(messageOf(error), analysis.urls)}`);
      return 1;
    }

    let receipt: UndoReceipt | undefined;
    const knownUrls = [...new Set([...target.urls, ...analysis.urls])];
    if (options.history) receipt = await options.history.prepare("remote", revalidated.map(({ branchName, fullName, oid }) => ({ name: branchName, fullName, oid })), { name: analysis.remote, endpoint: target.inventoryRepository, urls: knownUrls });
    try {
      await options.repository.deleteRemoteBranches(target.inventoryRepository, revalidated);
    } catch (error) {
      if (receipt) {
        try { if (options.repository.remoteHeadOids) await options.history!.reconcileRemote(receipt, await options.repository.remoteHeadOids(target.inventoryRepository)); } catch {}
      }
      options.output.err(`Remote deletion failed: ${redact(messageOf(error), knownUrls)}`);
      return 1;
    }

    const completed = receipt ? await options.history!.complete(receipt, new Set(revalidated.map(({ branchName }) => branchName))) : undefined;
    for (const { fullName } of revalidated) options.output.out(`Deleted ${fullName}`);
    options.output.out(`Deleted ${revalidated.length} remote ${revalidated.length === 1 ? "branch" : "branches"}.`);
    if (completed) { options.output.out(`Rollback ID: ${completed.id}`); options.output.out(`branch-care undo ${completed.id}`); }
    return 0;
  } catch (error) {
    if (isCancellation(error)) return noOp(options);
    options.output.err(redact(messageOf(error), [...new Set([...target.urls, ...analysis.urls])]));
    return 1;
  }
  } finally { lock?.release(); }
}
