import assert from "node:assert/strict";
import test from "node:test";
import { GitClient } from "../src/git/client.js";
import { Repository } from "../src/git/repository.js";
import { branch, git, makeDirectory, makeRepo, refs, repositoryName, runCli, assertExit, snapshotDirectory } from "./helpers.js";

test("status prints repository summary and groups", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  branch(fixture.dir, "topic");
  const result = runCli(fixture.dir, ["status"]); assertExit(result, 0);
  assert.match(result.stdout, new RegExp(`Repository: ${repositoryName(fixture.dir)}`));
  assert.match(result.stdout, /Base branch: main/);
  assert.match(result.stdout, /Current branch\n→ main/);
  for (const group of ["Merged branches", "Stale branches", "Protected branches"]) assert.match(result.stdout, new RegExp(group));
});

test("status prints complete branch metadata", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  branch(fixture.dir, "topic");
  git(fixture.dir, "update-ref", "refs/remotes/origin/topic", "refs/heads/topic");
  git(fixture.dir, "config", "remote.origin.url", "https://example.test/repo.git");
  git(fixture.dir, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git(fixture.dir, "config", "branch.topic.remote", "origin");
  git(fixture.dir, "config", "branch.topic.merge", "refs/heads/topic");
  const result = runCli(fixture.dir, ["status"]); assertExit(result, 0);
  assert.match(result.stdout, /topic \| commit: \d{4}-\d\d-\d\dT.*Z \| age: \d+ days \| author: Branch Tester \| upstream: origin\/topic/);
  assert.match(result.stdout, /main .* upstream: none/);
});

test("missing base exits one without mutation", (t) => {
  const fixture = makeRepo("topic"); t.after(fixture.cleanup);
  const before = refs(fixture.dir);
  const automatic = runCli(fixture.dir, ["status"]); assertExit(automatic, 1);
  assert.match(automatic.stderr, /Unable to resolve a base branch.*--base <branch>/s);
  const explicit = runCli(fixture.dir, ["status", "--base", "missing"]); assertExit(explicit, 1);
  assert.match(explicit.stderr, /Base branch 'missing' does not exist/);
  assert.equal(refs(fixture.dir), before);
});

test("status rejects a non-repository", (t) => {
  const fixture = makeDirectory(); t.after(fixture.cleanup);
  const before = snapshotDirectory(fixture.dir);
  const result = runCli(fixture.dir, ["status"]); assertExit(result, 1);
  assert.match(result.stderr, /Not a Git repository/);
  assert.equal(snapshotDirectory(fixture.dir), before);
});

test("status reports detached head", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  branch(fixture.dir, "topic");
  git(fixture.dir, "checkout", "-q", "--detach", "HEAD");
  const result = runCli(fixture.dir, ["status"]); assertExit(result, 0);
  assert.match(result.stdout, /Current branch\n→ detached HEAD/);
  const analysis = await new Repository(new GitClient(fixture.dir)).analyze();
  assert.equal(analysis.currentBranch, undefined);
  assert.ok(analysis.branches.length > 0);
  assert.equal(analysis.branches.every((localBranch) => localBranch.isCurrent === false), true);
});

test("successful status exits zero for empty groups", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const result = runCli(fixture.dir, ["status"]); assertExit(result, 0);
  assert.match(result.stdout, /Merged branches\n\(none\)/);
  assert.match(result.stdout, /Stale branches\n\(none\)/);
});
