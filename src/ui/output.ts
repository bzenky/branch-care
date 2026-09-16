import type { BranchFacts, RepositoryAnalysis } from "../types.js";

export function compareBytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export function sortBranches(names: readonly string[]): string[] {
  return [...names].sort(compareBytewise);
}

export function sortBranchFacts(branches: readonly BranchFacts[]): BranchFacts[] {
  return [...branches].sort((left, right) => compareBytewise(left.name, right.name));
}

export function formatBranch(branch: BranchFacts): string {
  const upstreamState = branch.upstreamState ?? (branch.upstream === undefined ? "none" : "tracking");
  return `${branch.name} | commit: ${branch.commitTimestamp.toISOString()} | age: ${branch.ageDays} days | author: ${branch.author} | upstream: ${branch.upstream ?? "none"} | upstream state: ${upstreamState}`;
}

function formatGroup(title: string, branches: readonly BranchFacts[]): string[] {
  const ordered = sortBranchFacts(branches);
  return [title, ...(ordered.length === 0 ? ["(none)"] : ordered.map(formatBranch))];
}

export function formatStatus(analysis: RepositoryAnalysis): string {
  const lines = [
    `Repository: ${analysis.repositoryName}`,
    `Base branch: ${analysis.baseBranch}`,
    "",
    "Current branch",
    `→ ${analysis.currentBranch ?? "detached HEAD"}`,
    ""
  ];
  lines.push(...formatGroup("Merged branches", analysis.branches.filter((branch) => branch.isMerged && !branch.isProtected)), "");
  lines.push(...formatGroup("Stale branches", analysis.branches.filter((branch) => branch.isStale)), "");
  lines.push(...formatGroup("Protected branches", analysis.branches.filter((branch) => branch.isProtected)));
  return `${lines.join("\n")}\n`;
}
