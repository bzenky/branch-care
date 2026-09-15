import type { BranchFacts, BranchMetadata } from "./types.js";

export const STALE_AFTER_DAYS = 60;
const DAY_MS = 86_400_000;
const protectedNames = new Set(["main", "master", "develop", "staging", "production"]);

export function resolveBase(explicit: string | undefined, originHead: string | undefined, localBranches: readonly string[]): string | undefined {
  const existing = new Set(localBranches);
  if (explicit !== undefined) return existing.has(explicit) ? explicit : undefined;
  if (originHead && existing.has(originHead)) return originHead;
  return ["main", "master", "develop"].find((name) => existing.has(name));
}

export function ageInCompleteDays(commitTimestamp: Date, now = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - commitTimestamp.getTime()) / DAY_MS));
}

export function isProtectedBranch(name: string, currentBranch: string | undefined, baseBranch: string): boolean {
  return protectedNames.has(name) || name.startsWith("release/") || name === currentBranch || name === baseBranch;
}

export function isDeletionCandidate(facts: { isMerged: boolean; isCurrent: boolean; isProtected: boolean }): boolean {
  return facts.isMerged && !facts.isCurrent && !facts.isProtected;
}

export function classifyBranch(
  branch: BranchMetadata,
  context: { currentBranch: string | undefined; baseBranch: string; merged: boolean; now?: Date }
): BranchFacts {
  const ageDays = ageInCompleteDays(branch.commitTimestamp, context.now);
  const isCurrent = branch.name === context.currentBranch;
  const isProtected = isProtectedBranch(branch.name, context.currentBranch, context.baseBranch);
  const isStale = ageDays >= STALE_AFTER_DAYS;
  return {
    ...branch,
    ageDays,
    isCurrent,
    isMerged: context.merged,
    isStale,
    isProtected,
    isCandidate: isDeletionCandidate({ isMerged: context.merged, isCurrent, isProtected })
  };
}
