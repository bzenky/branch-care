import assert from "node:assert/strict";
import test from "node:test";
import { ageInCompleteDays, classifyBranch, isDeletionCandidate, isProtectedBranch, resolveBase } from "../src/analysis.js";

const now = new Date("2025-03-01T12:00:00.000Z");

test("automatic base precedence covers every source", () => {
  assert.equal(resolveBase(undefined, "develop", ["main", "master", "develop"]), "develop");
  assert.equal(resolveBase(undefined, undefined, ["main", "master", "develop"]), "main");
  assert.equal(resolveBase(undefined, undefined, ["master", "develop"]), "master");
  assert.equal(resolveBase(undefined, undefined, ["develop"]), "develop");
  assert.equal(resolveBase(undefined, undefined, ["topic"]), undefined);
});

test("explicit base overrides automatic sources", () => {
  assert.equal(resolveBase("topic", "main", ["main", "topic"]), "topic");
  assert.equal(resolveBase("missing", "main", ["main"]), undefined);
});

test("stale threshold covers fifty-nine and sixty days", () => {
  assert.equal(ageInCompleteDays(new Date(now.getTime() - 59 * 86_400_000), now), 59);
  assert.equal(classifyBranch({ name: "a", commitTimestamp: new Date(now.getTime() - 59 * 86_400_000), author: "A", upstream: undefined }, { currentBranch: "main", baseBranch: "main", merged: false, now }).isStale, false);
  assert.equal(classifyBranch({ name: "a", commitTimestamp: new Date(now.getTime() - 60 * 86_400_000), author: "A", upstream: undefined }, { currentBranch: "main", baseBranch: "main", merged: false, now }).isStale, true);
});

test("protection table covers all eight rules", () => {
  for (const name of ["main", "master", "develop", "staging", "production", "release/2.4"]) {
    assert.equal(isProtectedBranch(name, "topic", "base"), true, name);
  }
  assert.equal(isProtectedBranch("topic", "topic", "base"), true);
  assert.equal(isProtectedBranch("base", "topic", "base"), true);
  assert.equal(isProtectedBranch("release", "topic", "base"), false);
});

test("stale unmerged branch is not a candidate", () => {
  const facts = classifyBranch({ name: "old", commitTimestamp: new Date(0), author: "A", upstream: undefined }, { currentBranch: "main", baseBranch: "main", merged: false, now });
  assert.equal(facts.isStale, true);
  assert.equal(facts.isCandidate, false);
  assert.equal(isDeletionCandidate({ isMerged: true, isCurrent: false, isProtected: false }), true);
  assert.equal(isDeletionCandidate({ isMerged: true, isCurrent: true, isProtected: false }), false);
  assert.equal(isDeletionCandidate({ isMerged: true, isCurrent: false, isProtected: true }), false);
  assert.equal(isDeletionCandidate({ isMerged: false, isCurrent: false, isProtected: false }), false);
});

test("protected facts always exclude candidacy", () => {
  for (const timestamp of [now, new Date(0)]) {
    const facts = classifyBranch({ name: "production", commitTimestamp: timestamp, author: "A", upstream: undefined }, { currentBranch: "topic", baseBranch: "main", merged: true, now });
    assert.equal(facts.isCandidate, false);
  }
});

test("classification facts are non-exclusive", () => {
  const facts = classifyBranch({ name: "main", commitTimestamp: new Date(0), author: "A", upstream: undefined }, { currentBranch: "main", baseBranch: "main", merged: true, now });
  assert.deepEqual({ current: facts.isCurrent, merged: facts.isMerged, stale: facts.isStale, protected: facts.isProtected }, { current: true, merged: true, stale: true, protected: true });
});
