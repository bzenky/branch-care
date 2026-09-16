import assert from "node:assert/strict";
import test from "node:test";
import { formatStatus, sortBranches } from "../src/ui/output.js";
import type { BranchFacts, RepositoryAnalysis } from "../src/types.js";

test("branch groups use bytewise ascending order", () => {
  const names = ["zeta", "éclair", "alpha", "Zebra", "feature/x"];
  assert.deepEqual(sortBranches(names), ["Zebra", "alpha", "feature/x", "zeta", "éclair"]);
});

function facts(name: string, overrides: Partial<BranchFacts> = {}): BranchFacts {
  return {
    name,
    commitTimestamp: new Date("2025-01-01T00:00:00.000Z"),
    ageDays: 100,
    author: "Author",
    upstream: undefined,
    upstreamState: "none",
    isCurrent: false,
    isMerged: true,
    isStale: true,
    isProtected: false,
    isCandidate: true,
    ...overrides
  };
}

test("human groups remain bytewise ordered with upstream state", () => {
  const branches = [
    facts("éclair"), facts("alpha"), facts("Zebra"),
    facts("main", { isProtected: true, isCandidate: false }),
    facts("zulu", { isProtected: true, isCandidate: false }),
    facts("éprotected", { isProtected: true, isCandidate: false })
  ];
  const analysis: RepositoryAnalysis = {
    repositoryName: "repository", baseBranch: "main", baseSource: "main", currentBranch: "main", staleAfterDays: 60, branches
  };
  const output = formatStatus(analysis);
  for (const title of ["Merged branches", "Stale branches"]) {
    const group = output.slice(output.indexOf(title), output.indexOf("\n\n", output.indexOf(title)));
    assert.ok(group.indexOf("Zebra |") < group.indexOf("alpha |"));
    assert.ok(group.indexOf("alpha |") < group.indexOf("éclair |"));
  }
  assert.match(output, /Protected branches\nmain .*upstream state: none/);

  const groupNames = (title: string): string[] => {
    const start = output.indexOf(`${title}\n`) + title.length + 1;
    const end = output.indexOf("\n\n", start);
    return output.slice(start, end < 0 ? undefined : end).split("\n").filter((line) => line.includes(" | ")).map((line) => line.slice(0, line.indexOf(" | ")));
  };
  assert.deepEqual(groupNames("Merged branches"), ["Zebra", "alpha", "éclair"]);
  assert.deepEqual(groupNames("Stale branches"), ["Zebra", "alpha", "main", "zulu", "éclair", "éprotected"]);
  assert.deepEqual(groupNames("Protected branches"), ["main", "zulu", "éprotected"]);
});
