import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { GitClient } from "../src/git/client.js";
import { Repository } from "../src/git/repository.js";
import { branch, commit, makeRepo } from "./helpers.js";

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
