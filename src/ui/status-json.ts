import type { BaseSource, RepositoryAnalysis, UpstreamState } from "../types.js";
import { sortBranchFacts } from "./output.js";

export const BASE_SOURCES = ["cli", "repository", "originHead", "main", "master", "develop"] as const satisfies readonly BaseSource[];
export const UPSTREAM_STATES = ["none", "tracking", "gone"] as const satisfies readonly UpstreamState[];

export interface JsonBranchStatus {
  name: string;
  lastCommitAt: string;
  daysSinceLastCommit: number;
  author: string;
  upstream: string | null;
  upstreamState: UpstreamState;
  isCurrent: boolean;
  isMerged: boolean;
  isStale: boolean;
  isProtected: boolean;
  isDeletionCandidate: boolean;
}

export interface JsonStatusV1 {
  schemaVersion: 1;
  repository: string;
  baseBranch: {
    name: string;
    source: BaseSource;
  };
  currentBranch: string | null;
  detachedHead: boolean;
  staleAfterDays: number;
  branches: JsonBranchStatus[];
}

export function toJsonStatus(analysis: RepositoryAnalysis): JsonStatusV1 {
  if (analysis.baseSource === undefined || analysis.staleAfterDays === undefined) {
    throw new Error("JSON status requires resolved base source and stale threshold");
  }
  return {
    schemaVersion: 1,
    repository: analysis.repositoryName,
    baseBranch: {
      name: analysis.baseBranch,
      source: analysis.baseSource
    },
    currentBranch: analysis.currentBranch ?? null,
    detachedHead: analysis.currentBranch === undefined,
    staleAfterDays: analysis.staleAfterDays,
    branches: sortBranchFacts(analysis.branches).map((branch) => ({
      name: branch.name,
      lastCommitAt: branch.commitTimestamp.toISOString(),
      daysSinceLastCommit: branch.ageDays,
      author: branch.author,
      upstream: branch.upstream ?? null,
      upstreamState: branch.upstreamState ?? (branch.upstream === undefined ? "none" : "tracking"),
      isCurrent: branch.isCurrent,
      isMerged: branch.isMerged,
      isStale: branch.isStale,
      isProtected: branch.isProtected,
      isDeletionCandidate: branch.isCandidate
    }))
  };
}

export function formatJsonStatus(analysis: RepositoryAnalysis): string {
  return JSON.stringify(toJsonStatus(analysis), null, 2);
}
