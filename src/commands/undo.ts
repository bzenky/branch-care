import type { GitResult } from "../git/client.js";
import type { RemoteDeleteTarget } from "../types.js";
import { type UndoReceipt, UndoHistory } from "../undo-history.js";
import type { CommandOutput } from "./status.js";

export interface UndoRepository {
  resolveRemoteDeletionTarget(remote?: string): Promise<RemoteDeleteTarget | undefined>;
  remoteBranchesAbsent(target: RemoteDeleteTarget, names: readonly string[]): Promise<boolean>;
  restoreRemoteBranches(destination: string, entries: readonly { name: string; oid: string }[]): Promise<GitResult>;
  remoteHeadOids?(destination: string): Promise<Map<string, string>>;
}
export interface UndoOptions {
  history: UndoHistory;
  repository: UndoRepository;
  output: CommandOutput;
  prompts: { confirm(options: { message: string; default: false }): Promise<boolean>; input(options: { message: string }): Promise<string> };
  interactive: boolean;
  id?: string;
  list: boolean;
  discard?: string;
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function cancellation(error: unknown): boolean { return error instanceof Error && error.name === "ExitPromptError"; }
function bytewise<T extends { name: string }>(entries: readonly T[]): T[] { return [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))); }
function redact(value: string, urls: readonly string[]): string { return urls.reduce((text, url) => url ? text.replaceAll(url, "<remote>") : text, value); }
function preview(operation: UndoReceipt, output: CommandOutput): void {
  output.out(`Cleanup operation: ${operation.id}`);
  output.out(`Type: ${operation.kind}`);
  output.out(`Target: ${operation.kind === "remote" ? operation.remote : "local"}`);
  output.out("Branches:");
  for (const entry of bytewise(operation.entries)) output.out(`${entry.fullName} ${entry.oid}`);
}

export async function runUndo(options: UndoOptions): Promise<number> {
  let lock;
  try { lock = await options.history.acquire(); }
  catch (error) { options.output.err(messageOf(error)); return 1; }
  try {
    const operations = await options.history.reconcilePending(async (receipt) => {
      const target = await options.repository.resolveRemoteDeletionTarget(receipt.remote);
      if (!target || target.name !== receipt.remote || target.inventoryRepository !== receipt.remoteEndpoint) throw new Error("Remote push destination changed.");
      if (!options.repository.remoteHeadOids) throw new Error("Remote inventory is unavailable.");
      return options.repository.remoteHeadOids(receipt.remoteEndpoint!);
    });
    if (options.list) {
      if (!operations.length) options.output.out("No cleanups are available to undo.");
      for (const item of operations) options.output.out(`${item.id}\t${item.kind}\t${item.kind === "remote" ? item.remote : "local"}\t${item.completedAt}\t${item.entries.length}\t${item.state}`);
      return 0;
    }
    let operation: UndoReceipt;
    try { operation = await options.history.select(options.discard ?? options.id); }
    catch (error) { options.output.err(messageOf(error)); return 1; }
    preview(operation, options.output);
    if (operation.state === "pending" && !options.discard) { options.output.err("This cleanup has an uncertain remote outcome. Retry after the server is reachable or discard it explicitly."); return 1; }
    if (!options.interactive) { options.output.err("Interactive confirmation is required."); return 1; }
    try {
      if (options.discard) {
        const confirmed = await options.prompts.confirm({ message: `Permanently discard recovery for ${operation.id}?`, default: false });
        if (!confirmed) { options.output.out("Recovery was not discarded."); return 0; }
        await options.history.remove(operation); options.output.out(`Discarded ${operation.id}.`); return 0;
      }
      const confirmed = await options.prompts.confirm({ message: `Restore ${operation.entries.length} ${operation.entries.length === 1 ? "branch" : "branches"}?`, default: false });
      if (!confirmed) { options.output.out("No branches were restored."); return 0; }
      if (operation.kind === "local") {
        operation = await options.history.beginRestore(operation);
        const unresolved = []; const restored = [];
        for (const entry of bytewise(operation.entries)) {
          try {
            if (await options.history.localExists(entry.name)) throw new Error("branch already exists");
            if (!(await options.history.objectExists(entry.oid))) throw new Error("saved object is unavailable");
            await options.history.restoreLocal(entry); restored.push(entry); options.output.out(`Restored ${entry.name}`);
          } catch (error) { unresolved.push(entry); options.output.err(`Unresolved ${entry.name}: ${messageOf(error)}`); }
        }
        if (unresolved.length) { await options.history.retain(operation, unresolved); options.output.out(`Restored ${restored.length} ${restored.length === 1 ? "branch" : "branches"}.`); return 1; }
        await options.history.remove(operation); options.output.out(`Restored ${restored.length} ${restored.length === 1 ? "branch" : "branches"}.`); return 0;
      }
      const typed = await options.prompts.input({ message: `Type '${operation.remote}' to confirm remote restoration:` });
      if (typed !== operation.remote) { options.output.out("No branches were restored."); return 0; }
      const target = await options.repository.resolveRemoteDeletionTarget(operation.remote);
      if (!target || target.name !== operation.remote) throw new Error(`Remote '${operation.remote}' is not configured.`);
      if (target.inventoryRepository !== operation.remoteEndpoint) throw new Error(`Remote '${operation.remote}' push destination changed since cleanup; refusing restoration.`);
      for (const entry of operation.entries) if (!(await options.history.objectExists(entry.oid))) throw new Error(`Saved object for '${entry.fullName}' is unavailable.`);
      if (!(await options.repository.remoteBranchesAbsent(target, operation.entries.map(({ name }) => name)))) throw new Error("A remote branch targeted for restoration already exists or changed.");
      operation = await options.history.beginRestore(operation);
      try { await options.repository.restoreRemoteBranches(operation.remoteEndpoint!, operation.entries); }
      catch (error) {
        if (options.repository.remoteHeadOids) {
          try { await options.history.reconcileRemote(operation, await options.repository.remoteHeadOids(operation.remoteEndpoint!)); } catch {}
        }
        throw error;
      }
      await options.history.remove(operation);
      for (const entry of bytewise(operation.entries)) options.output.out(`Restored ${entry.fullName}`);
      options.output.out(`Restored ${operation.entries.length} remote ${operation.entries.length === 1 ? "branch" : "branches"}.`); return 0;
    } catch (error) {
      if (cancellation(error)) { options.output.out(options.discard ? "Recovery was not discarded." : "No branches were restored."); return 0; }
      options.output.err(redact(messageOf(error), operation.urls ?? [])); return 1;
    }
  } catch (error) { options.output.err(messageOf(error)); return 1; }
  finally { lock.release(); }
}
