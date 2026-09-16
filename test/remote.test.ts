import assert from "node:assert/strict";
import test from "node:test";
import { GitClient, GitCommandError, nativeGitRunner, type GitRunner } from "../src/git/client.js";
import { Repository } from "../src/git/repository.js";
import { formatRemote, sortMissingUpstreams, sortRemoteBranches } from "../src/ui/remote.js";
import type { MissingUpstream, RemoteAnalysis, RemoteBranchFacts } from "../src/types.js";
import { branch, git, makeRepo } from "./helpers.js";

function remoteBranch(name: string, overrides: Partial<RemoteBranchFacts> = {}): RemoteBranchFacts {
  return {
    name,
    commitTimestamp: new Date("2025-01-01T00:00:00.000Z"),
    ageDays: 100,
    author: "Author",
    isMerged: false,
    ...overrides
  };
}

function missingUpstream(name: string, upstream = `origin/${name}`): MissingUpstream {
  return { name, upstream };
}

function analysis(remoteBranches: RemoteBranchFacts[] = [], missingUpstreams: MissingUpstream[] = []): RemoteAnalysis {
  return { repositoryName: "repository", baseBranch: "main", remoteBranches, missingUpstreams };
}

function sectionLines(output: string, title: string, nextTitle: string): string[] {
  const start = output.indexOf(`${title}\n`) + title.length + 1;
  const end = output.indexOf(`\n\n${nextTitle}`, start);
  return output.slice(start, end < 0 ? undefined : end).split("\n").filter((line) => line.includes(" | "));
}

test("remote output is bytewise ordered without duplicates", () => {
  const names = ["zeta", "éclair", "alpha", "Zebra", "feature/x"];
  const output = formatRemote(analysis(names.map((name) => remoteBranch(`origin/${name}`))));
  const lines = sectionLines(output, "Remote branches", "Local branches with missing upstream");
  assert.deepEqual(lines.map((line) => line.slice(0, line.indexOf(" | "))), [
    "origin/Zebra", "origin/alpha", "origin/feature/x", "origin/zeta", "origin/éclair"
  ]);
  assert.equal(new Set(lines).size, lines.length);
  assert.deepEqual(sortRemoteBranches(names.map((name) => remoteBranch(name))).map(({ name }) => name), [
    "Zebra", "alpha", "feature/x", "zeta", "éclair"
  ]);
  assert.deepEqual(sortMissingUpstreams([missingUpstream("zeta"), missingUpstream("alpha"), missingUpstream("éclair")]).map(({ name }) => name), ["alpha", "zeta", "éclair"]);
});

test("remote formatter has stable clean output", () => {
  const value = analysis(
    [remoteBranch("origin/topic", { isMerged: true })],
    [missingUpstream("gone/topic")]
  );
  const first = formatRemote(value);
  const second = formatRemote(value);
  assert.equal(first, second);
  assert.equal(first, [
    "Repository: repository",
    "Base branch: main",
    "",
    "Remote branches",
    "origin/topic | commit: 2025-01-01T00:00:00.000Z | age: 100 days | author: Author | merged: yes",
    "",
    "Local branches with missing upstream",
    "gone/topic | upstream: origin/gone/topic",
    ""
  ].join("\n"));
  assert.doesNotMatch(first, /\u001b/);
  assert.doesNotMatch(first, /schemaVersion|branches\s*:/);
});

test("remote propagates ancestry failures", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  branch(fixture.dir, "topic");
  git(fixture.dir, "update-ref", "refs/remotes/origin/topic", "refs/heads/topic");
  const runner: GitRunner = async (cwd, args) => {
    if (args[0] === "merge-base") throw new GitCommandError(args, { code: 2, stderr: "fatal: ancestry unavailable" });
    return nativeGitRunner(cwd, args);
  };
  await assert.rejects(new Repository(new GitClient(fixture.dir, runner)).analyzeRemote(), /ancestry unavailable/);
});
