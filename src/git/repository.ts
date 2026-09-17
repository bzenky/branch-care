import { basename } from "node:path";
import { ageInCompleteDays, classifyBranch, isProtectedBranch, resolveConfiguredBaseSelection, type ResolvedBase } from "../analysis.js";
import {
  loadRepositoryConfiguration,
  writeRepositoryConfiguration,
  type EffectiveRepositoryConfiguration
} from "../config.js";
import type { BranchMetadata, PruneTarget, RemoteAnalysis, RemoteBranchFacts, RepositoryAnalysis, Revalidation } from "../types.js";
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

  async resolvePruneTarget(requestedRemote?: string): Promise<PruneTarget | undefined> {
    await this.ensureWorktree();
    const remotes = [...new Set((await this.git.run(["remote"])).stdout.split("\n").filter(Boolean))]
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
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

  async revalidate(name: string, explicitBase?: string): Promise<Revalidation> {
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
    return { eligible: true };
  }

  deleteBranch(name: string): Promise<void> {
    return this.git.deleteBranch(name);
  }
}
