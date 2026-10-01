import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { GitClient } from "../src/git/client.js";
import { Repository } from "../src/git/repository.js";
import { branch, commit, git, makeRepo } from "./helpers.js";

test("merged classification follows commit ancestry", async (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  branch(fixture.dir, "merged-topic");
  gitCheckout(fixture.dir, "unmerged-topic");
  commit(fixture.dir, "topic.txt", "work", "unmerged work");
  gitCheckout(fixture.dir, "main");
  const analysis = await new Repository(new GitClient(fixture.dir)).analyze();
  assert.equal(analysis.branches.find((item) => item.name === "merged-topic")?.isMerged, true);
  assert.equal(analysis.branches.find((item) => item.name === "unmerged-topic")?.isMerged, false);
});

function gitCheckout(cwd: string, name: string): void {
  const exists = execFileSync("git", ["branch", "--list", name], { cwd, encoding: "utf8" }).trim();
  execFileSync("git", exists ? ["checkout", "-q", name] : ["checkout", "-q", "-b", name], { cwd });
}

test("tag collisions preserve local branch identity and ancestry", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  branch(fixture.dir, "merged-topic");
  gitCheckout(fixture.dir, "unmerged-topic");
  commit(fixture.dir, "topic.txt", "work", "unmerged work");
  git(fixture.dir, "tag", "main");
  git(fixture.dir, "tag", "merged-topic");
  git(fixture.dir, "tag", "unmerged-topic", "refs/heads/main");
  git(fixture.dir, "checkout", "-q", "refs/heads/main");
  git(fixture.dir, "symbolic-ref", "HEAD", "refs/heads/main");
  const repository = new Repository(new GitClient(fixture.dir));
  const analysis = await repository.analyze("main");
  assert.equal(analysis.currentBranch, "main");
  assert.equal(analysis.branches.find(({ name }) => name === "merged-topic")?.isMerged, true);
  assert.equal(analysis.branches.find(({ name }) => name === "unmerged-topic")?.isMerged, false);
  assert.deepEqual(await repository.revalidate("merged-topic", "main"), { eligible: true });
  assert.deepEqual(await repository.revalidate("unmerged-topic", "main"), { eligible: false, reason: "is no longer merged into the base branch" });
});
