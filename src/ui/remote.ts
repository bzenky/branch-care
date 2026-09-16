import type { MissingUpstream, RemoteAnalysis, RemoteBranchFacts } from "../types.js";
import { compareBytewise } from "./output.js";

export function sortRemoteBranches(branches: readonly RemoteBranchFacts[]): RemoteBranchFacts[] {
  return [...branches].sort((left, right) => compareBytewise(left.name, right.name));
}

export function sortMissingUpstreams(upstreams: readonly MissingUpstream[]): MissingUpstream[] {
  return [...upstreams].sort((left, right) => compareBytewise(left.name, right.name));
}

export function formatRemoteBranch(branch: RemoteBranchFacts): string {
  return `${branch.name} | commit: ${branch.commitTimestamp.toISOString()} | age: ${branch.ageDays} days | author: ${branch.author} | merged: ${branch.isMerged ? "yes" : "no"}`;
}

export function formatRemote(analysis: RemoteAnalysis): string {
  const remoteBranches = sortRemoteBranches(analysis.remoteBranches);
  const missingUpstreams = sortMissingUpstreams(analysis.missingUpstreams);
  const lines = [
    `Repository: ${analysis.repositoryName}`,
    `Base branch: ${analysis.baseBranch}`,
    "",
    "Remote branches",
    ...(remoteBranches.length === 0 ? ["(none)"] : remoteBranches.map(formatRemoteBranch)),
    "",
    "Local branches with missing upstream",
    ...(missingUpstreams.length === 0 ? ["(none)"] : missingUpstreams.map(({ name, upstream }) => `${name} | upstream: ${upstream}`))
  ];
  return `${lines.join("\n")}\n`;
}
