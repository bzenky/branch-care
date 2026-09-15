import { BUILT_IN_PROTECTED_BRANCHES, DEFAULT_STALE_AFTER_DAYS, matchesProtectedPattern } from "./config.js";
import type { BranchFacts, BranchMetadata } from "./types.js";

export const STALE_AFTER_DAYS = DEFAULT_STALE_AFTER_DAYS;
const DAY_MS = 86_400_000;

export function resolveBase(explicit: string | undefined, originHead: string | undefined, localBranches: readonly string[]): string | undefined {
  const existing = new Set(localBranches);
  if (explicit !== undefined) return existing.has(explicit) ? explicit : undefined;
  if (originHead && existing.has(originHead)) return originHead;
  return ["main", "master", "develop"].find((name) => existing.has(name));
}

export function resolveConfiguredBase(
  explicit: string | undefined,
  configured: string | undefined,
  originHead: string | undefined,
  localBranches: readonly string[]
): string | undefined {
  const existing = new Set(localBranches);
  for (const candidate of [explicit, configured, originHead, "main", "master", "develop"]) {
    if (candidate !== undefined && existing.has(candidate)) return candidate;
    if (candidate === explicit && explicit !== undefined) return undefined;
    if (candidate === configured && configured !== undefined) return undefined;
  }
  return undefined;
}

export function ageInCompleteDays(commitTimestamp: Date, now = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - commitTimestamp.getTime()) / DAY_MS));
}

export function isProtectedBranch(
  name: string,
  currentBranch: string | undefined,
  baseBranch: string,
  protectedPatterns: readonly string[] = BUILT_IN_PROTECTED_BRANCHES
): boolean {
  return name === currentBranch || name === baseBranch || protectedPatterns.some((pattern) => matchesProtectedPattern(name, pattern));
}

export function isDeletionCandidate(facts: { isMerged: boolean; isCurrent: boolean; isProtected: boolean }): boolean {
  return facts.isMerged && !facts.isCurrent && !facts.isProtected;
}

export function classifyBranch(
  branch: BranchMetadata,
  context: {
    currentBranch: string | undefined;
    baseBranch: string;
    merged: boolean;
    now?: Date;
    staleAfterDays?: number;
    protectedPatterns?: readonly string[];
  }
): BranchFacts {
  const ageDays = ageInCompleteDays(branch.commitTimestamp, context.now);
  const isCurrent = branch.name === context.currentBranch;
  const isProtected = isProtectedBranch(branch.name, context.currentBranch, context.baseBranch, context.protectedPatterns);
  const isStale = ageDays >= (context.staleAfterDays ?? STALE_AFTER_DAYS);
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
