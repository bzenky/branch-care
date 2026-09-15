import assert from "node:assert/strict";
import test from "node:test";
import { runClean, type CleanPrompts, type CleanRepository } from "../src/commands/clean.js";
import { GitClient, nativeGitRunner, type GitRunner } from "../src/git/client.js";
import { Repository } from "../src/git/repository.js";
import type { RepositoryAnalysis, Revalidation } from "../src/types.js";
import { assertExit, branch, git, makeEmptyDirectory, makeRepo, refs, runCliInteractive } from "./helpers.js";

function analysis(candidates = ["alpha", "beta"]): RepositoryAnalysis {
  return {
    repositoryName: "repo", baseBranch: "main", currentBranch: "main",
    branches: ["main", ...candidates].map((name) => ({ name, commitTimestamp: new Date(0), ageDays: 100, author: "A", upstream: undefined, isCurrent: name === "main", isMerged: true, isStale: true, isProtected: name === "main", isCandidate: name !== "main" }))
  };
}

function setup(overrides: Partial<CleanRepository> = {}, candidateNames = ["alpha", "beta"]) {
  const calls: string[] = [];
  const repository: CleanRepository = {
    analyze: async () => analysis(candidateNames),
    revalidate: async (name) => ({ eligible: true } as Revalidation),
    deleteBranch: async (name) => { calls.push(`delete:${name}`); },
    ...overrides
  };
  const lines: string[] = [];
  return { repository, calls, lines, output: { out: (line: string) => lines.push(line), err: (line: string) => lines.push(`ERR:${line}`) } };
}

test("interactive candidates are eligible and initially selected", async () => {
  const fixture = setup(); let observed: unknown; let confirmationCalls = 0;
  const prompts: CleanPrompts = { select: async (options) => { observed = options; return []; }, confirm: async () => { confirmationCalls += 1; return false; } };
  const code = await runClean({ ...fixture, prompts, dryRun: false, interactive: true });
  assert.deepEqual(observed, [{ name: "alpha", value: "alpha", checked: true }, { name: "beta", value: "beta", checked: true }]);
  assert.equal(code, 0);
  assert.equal(confirmationCalls, 0);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.lines, ["No branches were removed."]);
});

test("selection summary precedes confirmation", async () => {
  const fixture = setup(); const events: string[] = [];
  const prompts: CleanPrompts = { select: async () => ["beta", "alpha"], confirm: async () => { events.push(...fixture.lines, "CONFIRM"); return false; } };
  await runClean({ ...fixture, prompts, dryRun: false, interactive: true });
  assert.deepEqual(events.slice(-4), ["Selected branches:", "alpha", "beta", "Total: 2", "CONFIRM"].slice(-4));
});

test("cleanup does not mutate before confirmation", async () => {
  const fixture = setup();
  const prompts: CleanPrompts = { select: async () => ["alpha"], confirm: async () => { assert.deepEqual(fixture.calls, []); return false; } };
  await runClean({ ...fixture, prompts, dryRun: false, interactive: true });
  assert.deepEqual(fixture.calls, []);
});

test("confirmation defaults to no", async () => {
  const fixture = setup(); let options: unknown;
  const prompts: CleanPrompts = { select: async () => ["alpha"], confirm: async (value) => { options = value; return false; } };
  await runClean({ ...fixture, prompts, dryRun: false, interactive: true });
  assert.deepEqual(options, { message: "Delete 1 branch?", default: false });
});

test("confirmation triggers per-branch safety revalidation", async (t) => {
  const checked: string[] = []; const fixture = setup({ revalidate: async (name) => { checked.push(name); return { eligible: true }; } });
  const prompts: CleanPrompts = { select: async () => ["alpha", "beta"], confirm: async () => true };
  await runClean({ ...fixture, prompts, dryRun: false, interactive: true });
  assert.deepEqual(checked, ["alpha", "beta"]);
  assert.deepEqual(fixture.calls, ["delete:alpha", "delete:beta"]);

  const realFixture = makeRepo(); t.after(realFixture.cleanup);
  branch(realFixture.dir, "alpha");
  branch(realFixture.dir, "release/1");
  const gitCalls: string[][] = [];
  const runner: GitRunner = async (cwd, args) => {
    gitCalls.push([...args]);
    return nativeGitRunner(cwd, args);
  };
  const repository = new Repository(new GitClient(realFixture.dir, runner));
  assert.deepEqual(await repository.revalidate("alpha"), { eligible: true });
  const currentRead = gitCalls.findIndex((args) => args.join("\0") === ["symbolic-ref", "--quiet", "--short", "HEAD"].join("\0"));
  const existenceRead = gitCalls.findIndex((args) => args[0] === "for-each-ref" && args.at(-1) === "refs/heads/");
  const baseRead = gitCalls.findIndex((args) => args.join("\0") === ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"].join("\0"));
  const ancestryRead = gitCalls.findIndex((args) => args.join("\0") === ["merge-base", "--is-ancestor", "alpha", "main"].join("\0"));
  assert.ok(currentRead >= 0, "current branch was re-read");
  assert.ok(existenceRead > currentRead, "local refs were re-read for existence and protection");
  assert.ok(baseRead > existenceRead, "base sources were re-read");
  assert.ok(ancestryRead > baseRead, "ancestry was re-read after identity safety facts");
  assert.deepEqual(await repository.revalidate("release/1"), { eligible: false, reason: "is protected" });
  assert.equal(gitCalls.some((args) => args[0] === "branch" && args[1] === "-d"), false);
  await repository.deleteBranch("alpha");
  assert.deepEqual(gitCalls.at(-1), ["branch", "-d", "--", "alpha"]);
});

test("revalidation skips all five ineligible states", async () => {
  const reasons: Record<string, Revalidation | Error> = {
    current: { eligible: false, reason: "is now the current branch" }, protected: { eligible: false, reason: "is protected" }, unmerged: { eligible: false, reason: "is no longer merged" }, missing: { eligible: false, reason: "no longer exists" }, unreadable: new Error("could not be read")
  };
  const fixture = setup({ revalidate: async (name) => { const value = reasons[name]; if (value instanceof Error) throw value; return value; } }, Object.keys(reasons));
  const prompts: CleanPrompts = { select: async () => Object.keys(reasons), confirm: async () => true };
  const code = await runClean({ ...fixture, prompts, dryRun: false, interactive: true });
  assert.equal(code, 1); assert.deepEqual(fixture.calls, []);
  for (const name of Object.keys(reasons)) assert.match(fixture.lines.join("\n"), new RegExp(`Skipped ${name}:`));
});

test("eligible branch uses one safe delete invocation", async () => {
  const fixture = setup({}, ["-topic with spaces"]);
  const prompts: CleanPrompts = { select: async () => ["-topic with spaces"], confirm: async () => true };
  await runClean({ ...fixture, prompts, dryRun: false, interactive: true });
  assert.deepEqual(fixture.calls, ["delete:-topic with spaces"]);

  const gitCalls: string[][] = [];
  const runner: GitRunner = async (_cwd, args) => { gitCalls.push([...args]); return { stdout: "", stderr: "" }; };
  await new GitClient("/tmp/repository", runner).deleteBranch("-topic with spaces");
  assert.deepEqual(gitCalls, [["branch", "-d", "--", "-topic with spaces"]]);
});

test("partial deletion continues and exits one", async (t) => {
  const evaluated: string[] = [];
  const fixture = setup({
    revalidate: async (name) => { evaluated.push(name); return { eligible: true }; },
    deleteBranch: async (name) => { if (name === "alpha") throw new Error("Git refused"); fixture.calls.push(`delete:${name}`); }
  });
  const prompts: CleanPrompts = { select: async () => ["alpha", "beta"], confirm: async () => true };
  const code = await runClean({ ...fixture, prompts, dryRun: false, interactive: true });
  assert.equal(code, 1); assert.deepEqual(evaluated, ["alpha", "beta"]); assert.deepEqual(fixture.calls, ["delete:beta"]);
  assert.match(fixture.lines.join("\n"), /Failed alpha: Git refused/);

  const processFixture = makeRepo();
  branch(processFixture.dir, "alpha");
  branch(processFixture.dir, "beta");
  const linkedWorktree = makeEmptyDirectory("branch-care-worktree-");
  git(processFixture.dir, "worktree", "add", "-q", linkedWorktree.dir, "alpha");
  t.after(() => {
    try { git(processFixture.dir, "worktree", "remove", "--force", linkedWorktree.dir); } catch {}
    linkedWorktree.cleanup();
    processFixture.cleanup();
  });
  const before = refs(processFixture.dir);
  const result = await runCliInteractive(processFixture.dir, ["clean"], [
    { waitFor: "Branches safe to delete:", input: "\r" },
    { waitFor: "Delete 2 branches?", input: "y\r" }
  ]);
  assertExit(result, 1);
  assert.match(result.stdout, /Failed alpha:/);
  assert.match(result.stdout, /used by worktree at/);
  assert.match(result.stdout, /Deleted beta/);
  assert.match(before, /refs\/heads\/alpha/);
  assert.match(refs(processFixture.dir), /refs\/heads\/alpha/);
  assert.doesNotMatch(refs(processFixture.dir), /refs\/heads\/beta/);
});

test("empty cleanup skips prompts", async (t) => {
  const fixture = setup({}, []); let count = 0;
  const prompts: CleanPrompts = { select: async () => { count++; return []; }, confirm: async () => { count++; return false; } };
  const code = await runClean({ ...fixture, prompts, dryRun: false, interactive: true });
  assert.equal(code, 0); assert.equal(count, 0); assert.deepEqual(fixture.lines, ["No branches are safe to delete."]);

  const processFixture = makeRepo(); t.after(processFixture.cleanup);
  const result = await runCliInteractive(processFixture.dir, ["clean"], []);
  assertExit(result, 0);
  assert.match(result.stdout, /No branches are safe to delete\./);
});

test("deselected branch is not evaluated or deleted after confirmation", async () => {
  const evaluated: string[] = [];
  const fixture = setup({ revalidate: async (name) => { evaluated.push(name); return { eligible: true }; } });
  const prompts: CleanPrompts = { select: async () => ["alpha"], confirm: async () => true };
  const code = await runClean({ ...fixture, prompts, dryRun: false, interactive: true });
  assert.equal(code, 0);
  assert.deepEqual(evaluated, ["alpha"]);
  assert.deepEqual(fixture.calls, ["delete:alpha"]);
  assert.doesNotMatch(fixture.lines.join("\n"), /beta/);
});
