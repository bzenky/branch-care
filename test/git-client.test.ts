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
