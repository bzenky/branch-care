import assert from "node:assert/strict";
import test from "node:test";
import { classifyBranch } from "../src/analysis.js";
import { GitClient, nativeGitRunner, type GitRunner } from "../src/git/client.js";
import { Repository } from "../src/git/repository.js";
import type { BranchMetadata, UpstreamState } from "../src/types.js";
import { branch, git, makeRepo } from "./helpers.js";

const timestamp = new Date("2025-01-01T00:00:00.000Z");

function metadata(upstreamState: UpstreamState, upstream?: string): BranchMetadata {
  return { name: "topic", commitTimestamp: timestamp, author: "Author", upstream, upstreamState };
}

test("branch without upstream reports none", () => {
  const facts = classifyBranch(metadata("none"), {
    currentBranch: "main",
    baseBranch: "main",
    merged: false,
    now: timestamp
  });
  assert.equal(facts.upstream, undefined);
  assert.equal(facts.upstreamState, "none");
});

test("upstream state is independent from branch classification", () => {
  const states: Array<[UpstreamState, string | undefined]> = [
    ["none", undefined],
    ["tracking", "origin/topic"],
    ["gone", "origin/topic"]
  ];
  const classifications = states.map(([upstreamState, upstream]) => classifyBranch(metadata(upstreamState, upstream), {
    currentBranch: "topic",
    baseBranch: "topic",
    merged: true,
    now: new Date("2025-04-01T00:00:00.000Z"),
    staleAfterDays: 1
  }));
  for (const facts of classifications) {
    assert.deepEqual(
      { current: facts.isCurrent, merged: facts.isMerged, stale: facts.isStale, protected: facts.isProtected, candidate: facts.isCandidate },
      { current: true, merged: true, stale: true, protected: true, candidate: false }
    );
  }
  assert.deepEqual(classifications.map(({ upstreamState }) => upstreamState), ["none", "tracking", "gone"]);
});

test("upstream analysis uses read-only Git operations", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  branch(fixture.dir, "tracking"); branch(fixture.dir, "gone");
  git(fixture.dir, "config", "remote.origin.url", "https://example.test/repository.git");
  git(fixture.dir, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  for (const name of ["tracking", "gone"]) {
    git(fixture.dir, "config", `branch.${name}.remote`, "origin");
    git(fixture.dir, "config", `branch.${name}.merge`, `refs/heads/${name}`);
  }
  git(fixture.dir, "update-ref", "refs/remotes/origin/tracking", "refs/heads/tracking");

  const calls: string[][] = [];
  const runner: GitRunner = async (cwd, args) => {
    calls.push([...args]);
    return nativeGitRunner(cwd, args);
  };
  const analysis = await new Repository(new GitClient(fixture.dir, runner)).analyze();
  assert.equal(analysis.branches.find(({ name }) => name === "tracking")?.upstreamState, "tracking");
  assert.equal(analysis.branches.find(({ name }) => name === "gone")?.upstreamState, "gone");

  const prohibited = /^(fetch|prune|push|update-ref)(?:\s|$)|^remote\s+(?:prune|remove|rm)(?:\s|$)|^branch\s+(?:-d|-D|--delete)(?:\s|$)|(?:^|\s)--prune(?:\s|$)|(?:^|\s)--delete(?:\s|$)/;
  assert.ok(calls.some((args) => args[0] === "for-each-ref"), "real Git upstream ref analysis was audited");
  for (const args of calls) assert.doesNotMatch(args.join(" "), prohibited);
});
