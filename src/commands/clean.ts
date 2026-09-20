import type { RemoteDeleteTarget, RepositoryAnalysis, Revalidation } from "../types.js";
import { sortBranches } from "../ui/output.js";
import type { CommandOutput } from "./status.js";
import type { UndoHistory, UndoReceipt } from "../undo-history.js";

export interface CheckboxChoice {
  name: string;
  value: string;
  checked: boolean;
}

export interface CleanPrompts {
  select(options: CheckboxChoice[]): Promise<string[]>;
  confirm(options: { message: string; default: false }): Promise<boolean>;
}

export interface CleanRepository {
  analyze(base?: string): Promise<RepositoryAnalysis>;
  revalidate(name: string, explicitBase?: string, olderThanDays?: number): Promise<Revalidation>;
  deleteBranch(name: string): Promise<void>;
  branchOid?(name: string): Promise<string>;
  remoteHeadOids?(destination: string): Promise<Map<string, string>>;
  resolveRemoteDeletionTarget?(remote?: string): Promise<RemoteDeleteTarget | undefined>;
}

export interface CleanOptions {
  repository: CleanRepository;
  prompts: CleanPrompts;
  output: CommandOutput;
  dryRun: boolean;
  interactive: boolean;
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

export async function runClean(options: CleanOptions): Promise<number> {
  let lock: Awaited<ReturnType<UndoHistory["acquire"]>> | undefined;
  try {
    if (options.history && !options.dryRun) {
      lock = await options.history.acquire();
      await options.history.reconcilePending(async (receipt) => {
        if (!options.repository.resolveRemoteDeletionTarget) throw new Error("Remote endpoint resolution is unavailable.");
        const target = await options.repository.resolveRemoteDeletionTarget(receipt.remote);
        if (!target || target.name !== receipt.remote || target.inventoryRepository !== receipt.remoteEndpoint) throw new Error("Remote push destination changed.");
        if (!options.repository.remoteHeadOids) throw new Error("Remote inventory is unavailable.");
        return options.repository.remoteHeadOids(receipt.remoteEndpoint!);
      });
      if (!(await options.history.assertCapacity(false, options.output))) { lock.release(); lock = undefined; return 1; }
    }
  } catch (error) { options.output.err(messageOf(error)); return 1; }
  try {
  let analysis: RepositoryAnalysis;
  try {
    analysis = await options.repository.analyze(options.base);
  } catch (error) {
    options.output.err(messageOf(error));
    return 1;
  }

  if (options.history && options.dryRun) {
    try { await options.history.assertCapacity(true, options.output); }
    catch (error) { options.output.err(messageOf(error)); return 1; }
  }

  if (!options.dryRun && !options.interactive) {
    options.output.err("Interactive selection is required.");
    return 1;
  }

  if (!analysis.currentBranch) {
    options.output.err("Cleanup requires an attached current branch.");
    return 1;
  }

  if (options.olderThanDays !== undefined) options.output.out(`Older than: ${options.olderThanDays}d`);
  const candidates = sortBranches(analysis.branches
    .filter((branch) => branch.isCandidate && (options.olderThanDays === undefined || branch.ageDays >= options.olderThanDays))
    .map((branch) => branch.name));
  if (candidates.length === 0) {
    options.output.out("No branches are safe to delete.");
    return 0;
  }

  if (options.dryRun) {
    options.output.out(["Dry run", "", "Would delete:", ...candidates, "", "No branches were removed."].join("\n"));
    return 0;
  }

  try {
    const selected = sortBranches(await options.prompts.select(candidates.map((name) => ({ name, value: name, checked: true }))));
    if (selected.length === 0) {
      options.output.out("No branches were removed.");
      return 0;
    }

    options.output.out("Selected branches:");
    for (const name of selected) options.output.out(name);
    options.output.out(`Total: ${selected.length}`);
    const confirmed = await options.prompts.confirm({ message: `Delete ${selected.length} ${selected.length === 1 ? "branch" : "branches"}?`, default: false });
    if (!confirmed) {
      options.output.out("No branches were removed.");
      return 0;
    }

    const eligible: { name: string; fullName: string; oid: string }[] = [];
    let failed = false;
    for (const name of selected) {
      let result: Revalidation;
      try { result = await options.repository.revalidate(name, options.base, options.olderThanDays); }
      catch (error) { options.output.err(`Skipped ${name}: ${messageOf(error)}`); failed = true; continue; }
      if (!result.eligible) { options.output.err(`Skipped ${name}: ${result.reason}`); failed = true; continue; }
      try { eligible.push({ name, fullName: name, oid: options.repository.branchOid ? await options.repository.branchOid(name) : "" }); }
      catch (error) { options.output.err(`Skipped ${name}: ${messageOf(error)}`); failed = true; }
    }
    let receipt: UndoReceipt | undefined;
    if (options.history && eligible.length) receipt = await options.history.prepare("local", eligible);
    const deleted: string[] = [];
    for (const { name } of eligible) {
      try { await options.repository.deleteBranch(name); deleted.push(name); options.output.out(`Deleted ${name}`); }
      catch (error) { options.output.err(`Failed ${name}: ${messageOf(error)}`); failed = true; }
    }
    const completed = receipt ? await options.history!.complete(receipt, new Set(deleted)) : undefined;
    options.output.out(`Deleted ${deleted.length} ${deleted.length === 1 ? "branch" : "branches"}.`);
    if (completed) { options.output.out(`Rollback ID: ${completed.id}`); options.output.out(`branch-care undo ${completed.id}`); }
    return failed ? 1 : 0;
  } catch (error) {
    if (isCancellation(error)) {
      options.output.out("No branches were removed.");
      return 0;
    }
    options.output.err(messageOf(error));
    return 1;
  }
  } finally { lock?.release(); }
}
