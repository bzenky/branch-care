import { basename } from "node:path";
import { ageInCompleteDays, classifyBranch, isProtectedBranch, resolveConfiguredBaseSelection, type ResolvedBase } from "../analysis.js";
import {
  loadRepositoryConfiguration,
  writeRepositoryConfiguration,
  type EffectiveRepositoryConfiguration
} from "../config.js";
import type { BranchMetadata, PruneTarget, RemoteAnalysis, RemoteBranchFacts, RemoteDeleteAnalysis, RemoteDeleteCandidate, RemoteDeleteTarget, RepositoryAnalysis, Revalidation } from "../types.js";
import { GitClient, GitCommandError } from "./client.js";

export class RepositoryError extends Error {}

type RemoteBranchMetadata = Pick<RemoteBranchFacts, "name" | "commitTimestamp" | "author">;

export interface ParsedPruneFetchRefspec {
  references: string[];
  negative: boolean;
}

function unsafeFetchConfiguration(remote: string): RepositoryError {
  return new RepositoryError(`Unsafe fetch configuration for remote '${remote}'. Fetch destinations must stay under refs/remotes/${remote}/.`);
}

export function parsePruneFetchRefspec(remote: string, refspec: string): ParsedPruneFetchRefspec {
  if (refspec.startsWith("^")) {
    const source = refspec.slice(1);
    if (!source || source.includes(":")) throw unsafeFetchConfiguration(remote);
    return { references: [source], negative: true };
  }

  const value = refspec.startsWith("+") ? refspec.slice(1) : refspec;
  const separator = value.indexOf(":");
  if (separator <= 0 || separator !== value.lastIndexOf(":") || separator === value.length - 1) {
    throw unsafeFetchConfiguration(remote);
  }
  const source = value.slice(0, separator);
  const destination = value.slice(separator + 1);
  const sourceWildcards = source.split("*").length - 1;
  const destinationWildcards = destination.split("*").length - 1;
  if (sourceWildcards > 1 || sourceWildcards !== destinationWildcards || !destination.startsWith(`refs/remotes/${remote}/`)) {
    throw unsafeFetchConfiguration(remote);
  }
  return { references: [source, destination], negative: false };
}

export function validateRemoteDeleteFetchRefspecs(remote: string, refspecs: readonly string[]): void {
  const positives = refspecs.filter((refspec) => !refspec.startsWith("^"));
  for (const refspec of refspecs) parsePruneFetchRefspec(remote, refspec);
  const expected = `refs/heads/*:refs/remotes/${remote}/*`;
  if (positives.length !== 1 || (positives[0]!.startsWith("+") ? positives[0]!.slice(1) : positives[0]) !== expected) {
    throw new RepositoryError(`Unsafe remote deletion mapping for remote '${remote}'. Expected ${expected}.`);
  }
}

export interface RemoteHeadInventory {
  defaultBranch: string | undefined;
  heads: Map<string, string>;
}

export function parseRemoteHeadInventory(stdout: string): RemoteHeadInventory {
  let defaultBranch: string | undefined;
  const heads = new Map<string, string>();
  for (const line of stdout.split("\n").filter(Boolean)) {
    const [value, ref, extra] = line.split("\t");
    if (!value || !ref || extra !== undefined) throw new RepositoryError("Unable to read remote branch inventory");
    if (value.startsWith("ref: ") && ref === "HEAD") {
      const target = value.slice("ref: ".length);
      if (target.startsWith("refs/heads/")) defaultBranch = target.slice("refs/heads/".length);
      continue;
    }
    if (ref.startsWith("refs/heads/") && /^[0-9a-f]{40,64}$/.test(value)) {
      heads.set(ref.slice("refs/heads/".length), value);
    }
  }
  return { defaultBranch, heads };
}

interface RemoteDeleteTrackingBranch {
  fullName: string;
  branchName: string;
  oid: string;
  commitTimestamp: Date;
}

export class Repository {
  constructor(private readonly git: GitClient) {}

  private async ensureWorktree(): Promise<void> {
    try {
      const result = await this.git.run(["rev-parse", "--is-inside-work-tree"]);
      if (result.stdout.trim() !== "true") throw new RepositoryError("Not a Git repository");
    } catch {
      throw new RepositoryError("Not a Git repository");
    }
  }

  private async root(): Promise<string> {
    await this.ensureWorktree();
    return (await this.git.run(["rev-parse", "--show-toplevel"])).stdout.trim();
  }

  private async currentBranch(): Promise<string | undefined> {
    try {
      return (await this.git.run(["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim() || undefined;
    } catch (error) {
      if (error instanceof GitCommandError && Number(error.code) === 1) return undefined;
      throw error;
    }
  }

  private async localBranches(): Promise<BranchMetadata[]> {
    const format = "%(refname)%00%(refname:short)%00%(committerdate:iso-strict)%00%(authorname)%00%(upstream:short)%00%(upstream)";
    const stdout = (await this.git.run(["for-each-ref", `--format=${format}`, "refs/", "refs/heads/"])).stdout;
    const records = stdout.split("\n").filter(Boolean).map((line) => line.split("\0"));
    const existingRefs = new Set(records.map(([refname]) => refname).filter((refname): refname is string => refname !== undefined));
    return records.filter(([refname]) => refname?.startsWith("refs/heads/")).map((record) => {
      const [refname, name, timestamp, author, upstreamShort, upstreamRef] = record;
      if (!refname || !name || !timestamp || author === undefined || upstreamShort === undefined || upstreamRef === undefined) {
        throw new RepositoryError("Unable to read local branch metadata");
      }
      const commitTimestamp = new Date(timestamp);
      if (Number.isNaN(commitTimestamp.getTime())) throw new RepositoryError(`Unable to read commit timestamp for '${name}'`);
      const upstream = upstreamShort || undefined;
      return {
        name,
        commitTimestamp,
        author,
        upstream,
        upstreamState: upstream === undefined ? "none" : existingRefs.has(upstreamRef) ? "tracking" : "gone"
      };
    });
  }

  private async remoteBranches(): Promise<RemoteBranchMetadata[]> {
    const format = "%(refname)%00%(refname:short)%00%(committerdate:iso-strict)%00%(authorname)%00%(symref)";
    const stdout = (await this.git.run(["for-each-ref", `--format=${format}`, "refs/remotes/"])).stdout;
    const records = stdout.split("\n").filter(Boolean).map((line) => line.split("\0"));
    return records.filter(([refname]) => refname?.startsWith("refs/remotes/")).flatMap((record) => {
      const [refname, name, timestamp, author, symref] = record;
      if (!refname || !name || !timestamp || author === undefined || symref === undefined) {
        throw new RepositoryError("Unable to read remote branch metadata");
      }
      const commitTimestamp = new Date(timestamp);
      if (Number.isNaN(commitTimestamp.getTime())) throw new RepositoryError(`Unable to read commit timestamp for '${name}'`);
      if (symref) return [];
      return [{ name, commitTimestamp, author }];
    });
  }

  private async remoteDeleteTrackingBranches(remote: string): Promise<RemoteDeleteTrackingBranch[]> {
    const format = "%(refname)%00%(objectname)%00%(committerdate:iso-strict)%00%(symref)";
    const stdout = (await this.git.run(["for-each-ref", `--format=${format}`, `refs/remotes/${remote}/`])).stdout;
    const prefix = `refs/remotes/${remote}/`;
    return stdout.split("\n").filter(Boolean).flatMap((line) => {
      const [refname, oid, timestamp, symref, extra] = line.split("\0");
      if (!refname || !oid || !timestamp || symref === undefined || extra !== undefined || !refname.startsWith(prefix)) {
        throw new RepositoryError("Unable to read remote deletion branch metadata");
      }
      if (symref) return [];
      const commitTimestamp = new Date(timestamp);
      if (Number.isNaN(commitTimestamp.getTime())) throw new RepositoryError(`Unable to read commit timestamp for '${refname}'`);
      const branchName = refname.slice(prefix.length);
      return [{ fullName: `${remote}/${branchName}`, branchName, oid, commitTimestamp }];
    });
  }

  private async originHead(): Promise<string | undefined> {
    try {
      const value = (await this.git.run(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).stdout.trim();
      return value.startsWith("origin/") ? value.slice("origin/".length) : undefined;
    } catch (error) {
      if (error instanceof GitCommandError && Number(error.code) === 1) return undefined;
      throw error;
    }
  }

  private async baseBranch(
    explicit: string | undefined,
    configured: string | null,
    branches: readonly BranchMetadata[]
  ): Promise<ResolvedBase> {
    const names = branches.map((branch) => branch.name);
    const base = resolveConfiguredBaseSelection(explicit, configured ?? undefined, await this.originHead(), names);
    if (base) return base;
    if (explicit !== undefined) {
      throw new RepositoryError(`Base branch '${explicit}' does not exist (CLI source). Choose an existing local branch with --base <branch>.`);
    }
    if (configured !== null) {
      throw new RepositoryError(`Base branch '${configured}' does not exist (repository configuration source).`);
    }
    throw new RepositoryError("Unable to resolve a base branch. Specify an existing local branch with --base <branch>.");
  }

  private async isAncestor(branch: string, base: string): Promise<boolean> {
    try {
      await this.git.run(["merge-base", "--is-ancestor", branch, base]);
      return true;
    } catch (error) {
      if (error instanceof GitCommandError && Number(error.code) === 1) return false;
      throw error;
    }
  }

  private ensureConfiguredBaseExists(configuration: EffectiveRepositoryConfiguration, branches: readonly BranchMetadata[]): void {
    if (configuration.baseBranch !== null && !branches.some(({ name }) => name === configuration.baseBranch)) {
      throw new RepositoryError(`Base branch '${configuration.baseBranch}' does not exist (repository configuration source).`);
    }
  }

  async configuration(): Promise<EffectiveRepositoryConfiguration> {
    const root = await this.root();
    const configuration = loadRepositoryConfiguration(root);
    this.ensureConfiguredBaseExists(configuration, await this.localBranches());
    return configuration;
  }

  async updateBaseConfiguration(baseBranch: string): Promise<string> {
    const root = await this.root();
    const configuration = loadRepositoryConfiguration(root);
    const branches = await this.localBranches();
    this.ensureConfiguredBaseExists(configuration, branches);
    if (!branches.some(({ name }) => name === baseBranch)) {
      throw new RepositoryError(`Base branch '${baseBranch}' does not exist (CLI source).`);
    }
    return writeRepositoryConfiguration(root, { ...configuration, baseBranch });
  }

  private async configurationValues(key: string): Promise<string[]> {
    try {
      const stdout = (await this.git.run(["config", "--get-all", "--null", key])).stdout;
      return stdout.split("\0").filter(Boolean);
    } catch (error) {
      if (error instanceof GitCommandError && Number(error.code) === 1) return [];
      throw error;
    }
  }

  private async validateRefspecReference(remote: string, reference: string): Promise<void> {
    try {
      await this.git.run(["check-ref-format", "--refspec-pattern", reference]);
    } catch (error) {
      if (error instanceof GitCommandError && Number(error.code) === 1) throw unsafeFetchConfiguration(remote);
      throw error;
    }
  }

  async configuredRemotes(): Promise<string[]> {
    await this.ensureWorktree();
    return [...new Set((await this.git.run(["remote"])).stdout.split("\n").filter(Boolean))]
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  }

  async resolvePruneTarget(requestedRemote?: string): Promise<PruneTarget | undefined> {
    const remotes = await this.configuredRemotes();
    if (requestedRemote !== undefined && !remotes.includes(requestedRemote)) {
      throw new RepositoryError(`Remote '${requestedRemote}' is not configured.`);
    }
    if (remotes.length === 0) return undefined;
    if (requestedRemote === undefined && remotes.length > 1) {
      throw new RepositoryError(`Multiple remotes are configured: ${remotes.join(", ")}. Use --remote <name>.`);
    }
    const name = requestedRemote ?? remotes[0]!;
    const refspecs = await this.configurationValues(`remote.${name}.fetch`);
    if (refspecs.length === 0) throw unsafeFetchConfiguration(name);
    for (const refspec of refspecs) {
      const parsed = parsePruneFetchRefspec(name, refspec);
      for (const reference of parsed.references) await this.validateRefspecReference(name, reference);
    }
    const urls = [
      ...await this.configurationValues(`remote.${name}.url`),
      ...await this.configurationValues(`remote.${name}.pushurl`)
    ];
    return { name, urls: [...new Set(urls)] };
  }

  previewPrune(target: PruneTarget) {
    return this.git.fetchPrune(target.name, true);
  }

  executePrune(target: PruneTarget) {
    return this.git.fetchPrune(target.name, false);
  }

  async resolveRemoteDeletionTarget(requestedRemote?: string): Promise<RemoteDeleteTarget | undefined> {
    const target = await this.resolvePruneTarget(requestedRemote);
    if (!target) return undefined;
    const refspecs = await this.configurationValues(`remote.${target.name}.fetch`);
    validateRemoteDeleteFetchRefspecs(target.name, refspecs);
    const pushUrls = await this.configurationValues(`remote.${target.name}.pushurl`);
    if (pushUrls.length > 1) {
      throw new RepositoryError(`Unsafe remote deletion endpoint for remote '${target.name}'. Configure at most one push URL.`);
    }
    return { ...target, inventoryRepository: pushUrls[0] ?? target.name };
  }

  private async remoteHeadInventory(target: RemoteDeleteTarget): Promise<RemoteHeadInventory> {
    try {
      return parseRemoteHeadInventory((await this.git.listRemoteHeads(target.inventoryRepository)).stdout);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RepositoryError(target.urls.reduce((value, url) => url ? value.replaceAll(url, "<remote>") : value, message));
    }
  }

  async analyzeRemoteDeletion(requestedRemote?: string, explicitBase?: string, olderThanDays?: number): Promise<RemoteDeleteAnalysis> {
    const root = await this.root();
    const configuration = loadRepositoryConfiguration(root);
    const target = await this.resolveRemoteDeletionTarget(requestedRemote);
    if (!target) return { remote: "", urls: [], candidates: [] };
    const [currentBranch, branches, trackingBranches, inventory] = await Promise.all([
      this.currentBranch(), this.localBranches(), this.remoteDeleteTrackingBranches(target.name), this.remoteHeadInventory(target)
    ]);
    if (!currentBranch) throw new RepositoryError("Remote cleanup requires an attached current branch.");
    this.ensureConfiguredBaseExists(configuration, branches);
    const base = await this.baseBranch(explicitBase, configuration.baseBranch, branches);
    if (!inventory.defaultBranch) throw new RepositoryError(`Unable to resolve the default branch for remote '${target.name}'.`);
    const candidates: RemoteDeleteCandidate[] = [];
    const now = new Date();
    for (const branch of trackingBranches) {
      const protectedBranch = branch.branchName === inventory.defaultBranch
        || isProtectedBranch(branch.branchName, currentBranch, base.name, configuration.protectedBranches);
      if (protectedBranch || !(await this.isAncestor(branch.fullName, base.name))) continue;
      const serverOid = inventory.heads.get(branch.branchName);
      if (serverOid !== branch.oid) {
        throw new RepositoryError(`Remote state for '${branch.fullName}' differs from local tracking data. Run branch-care prune --remote ${target.name} and review again.`);
      }
      const ageDays = ageInCompleteDays(branch.commitTimestamp, now);
      if (olderThanDays === undefined || ageDays >= olderThanDays) candidates.push({ ...branch, ageDays });
    }
    const unique = new Map(candidates.map((candidate) => [candidate.fullName, candidate]));
    return {
      remote: target.name,
      urls: target.urls,
      candidates: [...unique.values()].sort((left, right) => Buffer.compare(Buffer.from(left.fullName), Buffer.from(right.fullName)))
    };
  }

  async revalidateRemoteDeletion(
    remote: string,
    selected: readonly RemoteDeleteCandidate[],
    explicitBase?: string,
    olderThanDays?: number
  ): Promise<RemoteDeleteCandidate[]> {
    const analysis = await this.analyzeRemoteDeletion(remote, explicitBase, olderThanDays);
    return selected.map((expected) => {
      const current = analysis.candidates.find(({ fullName }) => fullName === expected.fullName);
      if (!current) throw new RepositoryError(`Remote branch '${expected.fullName}' is no longer safe to delete.`);
      if (current.oid !== expected.oid) throw new RepositoryError(`Remote branch '${expected.fullName}' changed after selection.`);
      return current;
    });
  }

  deleteRemoteBranches(remote: string, candidates: readonly RemoteDeleteCandidate[]) {
    return this.git.deleteRemoteBranches(remote, candidates);
  }

  async analyze(explicitBase?: string): Promise<RepositoryAnalysis> {
    const root = await this.root();
    const configuration = loadRepositoryConfiguration(root);
    const [currentBranch, branches] = await Promise.all([this.currentBranch(), this.localBranches()]);
    this.ensureConfiguredBaseExists(configuration, branches);
    const base = await this.baseBranch(explicitBase, configuration.baseBranch, branches);
    const facts = await Promise.all(branches.map(async (branch) => classifyBranch(branch, {
      currentBranch,
      baseBranch: base.name,
      merged: await this.isAncestor(branch.name, base.name),
      staleAfterDays: configuration.staleAfterDays,
      protectedPatterns: configuration.protectedBranches
    })));
    return {
      repositoryName: basename(root),
      baseBranch: base.name,
      baseSource: base.source,
      currentBranch,
      staleAfterDays: configuration.staleAfterDays,
      branches: facts
    };
  }

  async analyzeRemote(explicitBase?: string): Promise<RemoteAnalysis> {
    const root = await this.root();
    const configuration = loadRepositoryConfiguration(root);
    const [branches, remoteBranches] = await Promise.all([this.localBranches(), this.remoteBranches()]);
    this.ensureConfiguredBaseExists(configuration, branches);
    const base = await this.baseBranch(explicitBase, configuration.baseBranch, branches);
    const now = new Date();
    const facts = await Promise.all(remoteBranches.map(async (branch) => ({
      ...branch,
      ageDays: ageInCompleteDays(branch.commitTimestamp, now),
      isMerged: await this.isAncestor(branch.name, base.name)
    })));
    return {
      repositoryName: basename(root),
      baseBranch: base.name,
      remoteBranches: facts,
      missingUpstreams: branches.flatMap(({ name, upstream, upstreamState }) =>
        upstreamState === "gone" && upstream !== undefined ? [{ name, upstream }] : [])
    };
  }

  async revalidate(name: string, explicitBase?: string, olderThanDays?: number): Promise<Revalidation> {
    const root = await this.root();
    const configuration = loadRepositoryConfiguration(root);
    const [currentBranch, branches] = await Promise.all([this.currentBranch(), this.localBranches()]);
    if (!currentBranch) return { eligible: false, reason: "HEAD is detached" };
    this.ensureConfiguredBaseExists(configuration, branches);
    const base = await this.baseBranch(explicitBase, configuration.baseBranch, branches);
    const branch = branches.find((item) => item.name === name);
    if (!branch) return { eligible: false, reason: "no longer exists" };
    if (name === currentBranch) return { eligible: false, reason: "is now the current branch" };
    if (isProtectedBranch(name, currentBranch, base.name, configuration.protectedBranches)) {
      return { eligible: false, reason: "is protected" };
    }
    if (!(await this.isAncestor(name, base.name))) return { eligible: false, reason: "is no longer merged into the base branch" };
    if (olderThanDays !== undefined && ageInCompleteDays(branch.commitTimestamp) < olderThanDays) {
      return { eligible: false, reason: `is newer than the ${olderThanDays}d age filter` };
    }
    return { eligible: true };
  }

  deleteBranch(name: string): Promise<void> {
    return this.git.deleteBranch(name);
  }
}
