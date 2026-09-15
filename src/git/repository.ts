import { basename } from "node:path";
import { classifyBranch, isProtectedBranch, resolveBase } from "../analysis.js";
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

  private async baseBranch(explicit: string | undefined, branches: readonly BranchMetadata[]): Promise<string> {
    const base = resolveBase(explicit, await this.originHead(), branches.map((branch) => branch.name));
    if (base) return base;
    if (explicit !== undefined) throw new RepositoryError(`Base branch '${explicit}' does not exist. Choose an existing local branch with --base <branch>.`);
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

  async analyze(explicitBase?: string): Promise<RepositoryAnalysis> {
    await this.ensureWorktree();
    const [rootResult, currentBranch, branches] = await Promise.all([
      this.git.run(["rev-parse", "--show-toplevel"]),
      this.currentBranch(),
      this.localBranches()
    ]);
    const baseBranch = await this.baseBranch(explicitBase, branches);
    const facts = await Promise.all(branches.map(async (branch) => classifyBranch(branch, {
      currentBranch,
      baseBranch,
      merged: await this.isAncestor(branch.name, baseBranch)
    })));
    return { repositoryName: basename(rootResult.stdout.trim()), baseBranch, currentBranch, branches: facts };
  }

  async revalidate(name: string, explicitBase?: string): Promise<Revalidation> {
    await this.ensureWorktree();
    const [currentBranch, branches] = await Promise.all([this.currentBranch(), this.localBranches()]);
    if (!currentBranch) return { eligible: false, reason: "HEAD is detached" };
    const baseBranch = await this.baseBranch(explicitBase, branches);
    const branch = branches.find((item) => item.name === name);
    if (!branch) return { eligible: false, reason: "no longer exists" };
    if (name === currentBranch) return { eligible: false, reason: "is now the current branch" };
    if (isProtectedBranch(name, currentBranch, baseBranch)) return { eligible: false, reason: "is protected" };
    if (!(await this.isAncestor(name, baseBranch))) return { eligible: false, reason: "is no longer merged into the base branch" };
    return { eligible: true };
  }

  deleteBranch(name: string): Promise<void> {
    return this.git.deleteBranch(name);
  }
}
