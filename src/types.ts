export interface BranchMetadata {
  name: string;
  commitTimestamp: Date;
  author: string;
  upstream: string | undefined;
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
  currentBranch: string | undefined;
  branches: BranchFacts[];
}

export type Revalidation =
  | { eligible: true }
  | { eligible: false; reason: string };
