export type UpstreamState = "none" | "tracking" | "gone";
export type BaseSource = "cli" | "repository" | "originHead" | "main" | "master" | "develop";

export interface BranchMetadata {
  name: string;
  commitTimestamp: Date;
  author: string;
  upstream: string | undefined;
  upstreamState?: UpstreamState;
}

export interface BranchFacts extends BranchMetadata {
  ageDays: number;
  isCurrent: boolean;
  isMerged: boolean;
  isStale: boolean;
  isProtected: boolean;
  isCandidate: boolean;
}

export interface RepositoryAnalysis {
  repositoryName: string;
  baseBranch: string;
  baseSource?: BaseSource;
  currentBranch: string | undefined;
  staleAfterDays?: number;
  branches: BranchFacts[];
}

export type Revalidation =
  | { eligible: true }
  | { eligible: false; reason: string };
