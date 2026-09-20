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

export interface RemoteBranchFacts {
  name: string;
  commitTimestamp: Date;
  ageDays: number;
  author: string;
  isMerged: boolean;
}

export interface MissingUpstream {
  name: string;
  upstream: string;
}

export interface RemoteAnalysis {
  repositoryName: string;
  baseBranch: string;
  remoteBranches: RemoteBranchFacts[];
  missingUpstreams: MissingUpstream[];
}

export interface PruneTarget {
  name: string;
  urls: string[];
}

export interface RemoteDeleteTarget extends PruneTarget {
  inventoryRepository: string;
}

export interface RemoteDeleteCandidate {
  fullName: string;
  branchName: string;
  oid: string;
  ageDays: number;
}

export interface RemoteDeleteAnalysis {
  remote: string;
  urls: string[];
  candidates: RemoteDeleteCandidate[];
}

export type Revalidation =
  | { eligible: true }
  | { eligible: false; reason: string };
