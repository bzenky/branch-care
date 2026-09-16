import assert from "node:assert/strict";
import test from "node:test";
import { GitClient } from "../src/git/client.js";
import { Repository } from "../src/git/repository.js";
import { branch, git, makeRepo } from "./helpers.js";

function configureOriginUpstream(cwd: string, branchName: string): void {
  git(cwd, "config", "remote.origin.url", "https://example.test/repository.git");
  git(cwd, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git(cwd, "config", `branch.${branchName}.remote`, "origin");
  git(cwd, "config", `branch.${branchName}.merge`, `refs/heads/${branchName}`);
}

test("existing upstream ref reports tracking", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  branch(fixture.dir, "topic");
  configureOriginUpstream(fixture.dir, "topic");
  git(fixture.dir, "update-ref", "refs/remotes/origin/topic", "refs/heads/topic");
  const topic = (await new Repository(new GitClient(fixture.dir)).analyze()).branches.find(({ name }) => name === "topic");
  assert.deepEqual({ upstream: topic?.upstream, state: topic?.upstreamState }, { upstream: "origin/topic", state: "tracking" });
});

test("missing upstream ref reports gone", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  branch(fixture.dir, "topic");
  configureOriginUpstream(fixture.dir, "topic");
  const topic = (await new Repository(new GitClient(fixture.dir)).analyze()).branches.find(({ name }) => name === "topic");
  assert.deepEqual({ upstream: topic?.upstream, state: topic?.upstreamState }, { upstream: "origin/topic", state: "gone" });
});
