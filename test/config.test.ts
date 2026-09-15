import assert from "node:assert/strict";
import test from "node:test";
import { classifyBranch, isDeletionCandidate, isProtectedBranch, resolveConfiguredBase } from "../src/analysis.js";
import {
  BUILT_IN_PROTECTED_BRANCHES,
  canonicalizeConfiguration,
  validateRepositoryConfiguration
} from "../src/config.js";

const now = new Date("2025-03-01T12:00:00.000Z");

function validationMessage(value: unknown): string {
  try {
    validateRepositoryConfiguration(value);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

test("missing configuration resolves exact defaults", () => {
  assert.deepEqual(canonicalizeConfiguration({}), {
    baseBranch: null,
    staleAfterDays: 60,
    protectedBranches: BUILT_IN_PROTECTED_BRANCHES
  });
});

test("configured base precedence covers every source", () => {
  const branches = ["configured", "origin", "main", "master", "develop", "cli"];
  assert.equal(resolveConfiguredBase("cli", "configured", "origin", branches), "cli");
  assert.equal(resolveConfiguredBase(undefined, "configured", "origin", branches), "configured");
  assert.equal(resolveConfiguredBase(undefined, undefined, "origin", branches), "origin");
  assert.equal(resolveConfiguredBase(undefined, undefined, undefined, ["main", "master", "develop"]), "main");
  assert.equal(resolveConfiguredBase(undefined, undefined, undefined, ["master", "develop"]), "master");
  assert.equal(resolveConfiguredBase(undefined, undefined, undefined, ["develop"]), "develop");
});

test("repository protections extend immutable built-ins", () => {
  const patterns = canonicalizeConfiguration({ protectedBranches: ["team/*", "exact"] }).protectedBranches;
  for (const name of ["main", "master", "develop", "staging", "production", "release/2", "team/a", "exact"]) {
    assert.equal(isProtectedBranch(name, "current", "base", patterns), true, name);
  }
  assert.equal(isProtectedBranch("current", "current", "base", patterns), true);
  assert.equal(isProtectedBranch("base", "current", "base", patterns), true);
});

test("protected wildcard grammar covers star and literals", () => {
  for (const [pattern, matching, nonmatching] of [
    ["feature/*", "feature/", "features/"],
    ["feature/*", "feature/a/b", "feature"],
    ["a.b", "a.b", "axb"],
    ["a+b", "a+b", "ab"],
    ["a?b", "a?b", "acb"],
    ["a[b]", "a[b]", "ab"]
  ]) {
    assert.equal(isProtectedBranch(matching, undefined, "base", [pattern]), true, pattern);
    assert.equal(isProtectedBranch(nonmatching, undefined, "base", [pattern]), false, pattern);
  }
});

test("protected patterns canonicalize duplicates and order", () => {
  assert.deepEqual(
    canonicalizeConfiguration({ protectedBranches: ["zeta/*", "main", "alpha", "zeta/*", "éclair"] }).protectedBranches,
    [...BUILT_IN_PROTECTED_BRANCHES, "alpha", "zeta/*", "éclair"]
  );
});

test("configured stale threshold covers both boundary days", () => {
  const branch = (days: number) => ({ name: `day-${days}`, commitTimestamp: new Date(now.getTime() - days * 86_400_000), author: "A", upstream: undefined });
  assert.equal(classifyBranch(branch(9), { currentBranch: "main", baseBranch: "main", merged: false, now, staleAfterDays: 10 }).isStale, false);
  assert.equal(classifyBranch(branch(10), { currentBranch: "main", baseBranch: "main", merged: false, now, staleAfterDays: 10 }).isStale, true);
});

test("configured staleness never grants deletion eligibility", () => {
  const branch = { name: "old", commitTimestamp: new Date(0), author: "A", upstream: undefined };
  const stale = classifyBranch(branch, { currentBranch: "main", baseBranch: "main", merged: false, now, staleAfterDays: 1 });
  assert.equal(stale.isStale, true);
  assert.equal(stale.isCandidate, false);
  for (const facts of [
    { isMerged: false, isCurrent: false, isProtected: false },
    { isMerged: true, isCurrent: true, isProtected: false },
    { isMerged: true, isCurrent: false, isProtected: true }
  ]) assert.equal(isDeletionCandidate(facts), false);
  assert.equal(isDeletionCandidate({ isMerged: true, isCurrent: false, isProtected: false }), true);
});

test("non-object configuration roots are rejected", () => {
  for (const value of [[], "value", 1, true, null]) assert.match(validationMessage(value), /root value must be an object/);
});

test("unknown configuration keys are sorted and rejected", () => {
  const message = validationMessage({ zeta: 1, "éclair": 2, alpha: 3, Zebra: 4, middle: 5 });
  assert.equal(message, "unknown configuration keys: Zebra, alpha, middle, zeta, éclair");
});

test("invalid baseBranch values are rejected", () => {
  for (const value of ["", "   ", 1, null]) assert.match(validationMessage({ baseBranch: value }), /baseBranch.*non-empty string/);
});

test("invalid staleAfterDays values are rejected", () => {
  for (const value of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.match(validationMessage({ staleAfterDays: value }), /staleAfterDays.*safe integer.*greater than or equal to 1/);
  }
});

test("invalid protectedBranches values are rejected", () => {
  assert.match(validationMessage({ protectedBranches: "main" }), /protectedBranches.*array/);
  for (const value of ["", "  ", 1, null]) {
    assert.match(validationMessage({ protectedBranches: ["valid", value] }), /protectedBranches\[1\].*non-empty string/);
  }
});
