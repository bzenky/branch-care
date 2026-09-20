import assert from "node:assert/strict";
import test from "node:test";
import { GitClient, nativeGitRunner, type GitRunner } from "../src/git/client.js";
import { makeEmptyDirectory, writeNodeLauncher } from "./helpers.js";

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

test("native Git runner enforces one aggregate 10 MiB cap and cannot hang on ignored termination", async (t) => {
  const fixture = makeEmptyDirectory("branch-care-git-limit-"); t.after(fixture.cleanup); const originalExecutable = process.env.BRANCH_CARE_TEST_GIT_EXECUTABLE; const originalPrefix = process.env.BRANCH_CARE_TEST_GIT_PREFIX;
  const script = writeNodeLauncher(fixture.dir, "overflow", `process.on("SIGTERM", () => {}); for (let index = 0; index < 6; index += 1) process.stdout.write(Buffer.alloc(1024 * 1024)); for (let index = 0; index < 6; index += 1) process.stderr.write(Buffer.alloc(1024 * 1024)); setInterval(() => {}, 1000);`);
  process.env.BRANCH_CARE_TEST_GIT_EXECUTABLE = process.execPath; process.env.BRANCH_CARE_TEST_GIT_PREFIX = script;
  t.after(() => { if (originalExecutable === undefined) delete process.env.BRANCH_CARE_TEST_GIT_EXECUTABLE; else process.env.BRANCH_CARE_TEST_GIT_EXECUTABLE = originalExecutable; if (originalPrefix === undefined) delete process.env.BRANCH_CARE_TEST_GIT_PREFIX; else process.env.BRANCH_CARE_TEST_GIT_PREFIX = originalPrefix; });
  const started = Date.now();
  await assert.rejects(nativeGitRunner(fixture.dir, ["aggregate"]), /aggregate output exceeded the 10 MiB safety limit/);
  assert.ok(Date.now() - started < 2000, "overflow rejection must not wait for child exit");
});
