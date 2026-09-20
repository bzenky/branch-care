import assert from "node:assert/strict";
import test from "node:test";
import { GitClient, type GitRunner } from "../src/git/client.js";

test("git arguments preserve hostile branch names", async () => {
  const calls: string[][] = [];
  const runner: GitRunner = async (_cwd, args) => { calls.push([...args]); return { stdout: "", stderr: "" }; };
  const client = new GitClient("/tmp/repo", runner);
  await client.deleteBranch("-hostile branch name");
  assert.deepEqual(calls, [["branch", "-d", "--", "-hostile branch name"]]);
});

test("remote undo uses one atomic absence-leased push for every entry", async () => {
  const calls: string[][] = []; const runner: GitRunner = async (_cwd, args) => { calls.push([...args]); return { stdout: "", stderr: "" }; };
  await new GitClient("/tmp/repo", runner).restoreRemoteBranches("origin", [{ name: "alpha", oid: "a".repeat(40) }, { name: "team/zeta", oid: "b".repeat(40) }]);
  assert.deepEqual(calls, [["push", "--atomic", "--no-follow-tags", "--no-recurse-submodules", "--no-progress", "--force-with-lease=refs/heads/alpha:", "--force-with-lease=refs/heads/team/zeta:", "--", "origin", `${"a".repeat(40)}:refs/heads/alpha`, `${"b".repeat(40)}:refs/heads/team/zeta`]]);
});
