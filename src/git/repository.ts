import { basename } from "node:path";
import { classifyBranch, isProtectedBranch, resolveConfiguredBase } from "../analysis.js";
import {
  loadRepositoryConfiguration,
  writeRepositoryConfiguration,
  type EffectiveRepositoryConfiguration
} from "../config.js";
import type { BranchMetadata, RepositoryAnalysis, Revalidation } from "../types.js";
import { GitClient, GitCommandError } from "./client.js";

export class RepositoryError extends Error {}

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
    const format = "%(refname:short)%00%(committerdate:iso-strict)%00%(authorname)%00%(upstream:short)";
    const stdout = (await this.git.run(["for-each-ref", `--format=${format}`, "refs/heads/"])).stdout;
    return stdout.split("\n").filter(Boolean).map((line) => {
      const [name, timestamp, author, upstream] = line.split("\0");
      if (!name || !timestamp || author === undefined) throw new RepositoryError("Unable to read local branch metadata");
      const commitTimestamp = new Date(timestamp);
      if (Number.isNaN(commitTimestamp.getTime())) throw new RepositoryError(`Unable to read commit timestamp for '${name}'`);
      return { name, commitTimestamp, author, upstream: upstream || undefined };
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
  ): Promise<string> {
    const names = branches.map((branch) => branch.name);
    const base = resolveConfiguredBase(explicit, configured ?? undefined, await this.originHead(), names);
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

  async analyze(explicitBase?: string): Promise<RepositoryAnalysis> {
    const root = await this.root();
    const configuration = loadRepositoryConfiguration(root);
    const [currentBranch, branches] = await Promise.all([this.currentBranch(), this.localBranches()]);
    this.ensureConfiguredBaseExists(configuration, branches);
    const baseBranch = await this.baseBranch(explicitBase, configuration.baseBranch, branches);
    const facts = await Promise.all(branches.map(async (branch) => classifyBranch(branch, {
      currentBranch,
      baseBranch,
      merged: await this.isAncestor(branch.name, baseBranch),
      staleAfterDays: configuration.staleAfterDays,
      protectedPatterns: configuration.protectedBranches
    })));
    return { repositoryName: basename(root), baseBranch, currentBranch, branches: facts };
  }

  async revalidate(name: string, explicitBase?: string): Promise<Revalidation> {
    const root = await this.root();
    const configuration = loadRepositoryConfiguration(root);
    const [currentBranch, branches] = await Promise.all([this.currentBranch(), this.localBranches()]);
    if (!currentBranch) return { eligible: false, reason: "HEAD is detached" };
    this.ensureConfiguredBaseExists(configuration, branches);
    const baseBranch = await this.baseBranch(explicitBase, configuration.baseBranch, branches);
    const branch = branches.find((item) => item.name === name);
    if (!branch) return { eligible: false, reason: "no longer exists" };
    if (name === currentBranch) return { eligible: false, reason: "is now the current branch" };
    if (isProtectedBranch(name, currentBranch, baseBranch, configuration.protectedBranches)) {
      return { eligible: false, reason: "is protected" };
    }
    if (!(await this.isAncestor(name, baseBranch))) return { eligible: false, reason: "is no longer merged into the base branch" };
    return { eligible: true };
  }

  deleteBranch(name: string): Promise<void> {
    return this.git.deleteBranch(name);
  }
}
