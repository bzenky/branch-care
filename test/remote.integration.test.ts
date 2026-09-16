import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runRemote } from "../src/commands/remote.js";
import { GitClient, nativeGitRunner, type GitRunner } from "../src/git/client.js";
import { Repository } from "../src/git/repository.js";
import { branch, commit, git, makeDirectory, makeRepo, repositoryName, runCli, snapshotDirectory, assertExit } from "./helpers.js";

function addRemoteRef(cwd: string, remote: string, name: string, target = "refs/heads/main"): void {
  git(cwd, "update-ref", `refs/remotes/${remote}/${name}`, target);
}

function configureUpstream(cwd: string, name: string, exists: boolean): void {
  git(cwd, "config", "remote.origin.url", "https://example.test/repository.git");
  git(cwd, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git(cwd, "config", `branch.${name}.remote`, "origin");
  git(cwd, "config", `branch.${name}.merge`, `refs/heads/${name}`);
  if (exists) addRemoteRef(cwd, "origin", name, `refs/heads/${name}`);
}

function sectionLines(output: string, title: string, nextTitle?: string): string[] {
  const start = output.indexOf(`${title}\n`) + title.length + 1;
  const end = nextTitle === undefined ? output.length : output.indexOf(`\n\n${nextTitle}`, start);
  return output.slice(start, end < 0 ? undefined : end).split("\n").filter((line) => line.includes(" | "));
}

function remoteNames(output: string): string[] {
  return sectionLines(output, "Remote branches", "Local branches with missing upstream")
    .map((line) => line.slice(0, line.indexOf(" | ")));
}

function missingNames(output: string): string[] {
  return sectionLines(output, "Local branches with missing upstream")
    .map((line) => line.slice(0, line.indexOf(" | ")));
}

function allRefs(cwd: string): string {
  return git(cwd, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes");
}

async function runRepository(repository: Repository): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runRemote(repository, undefined, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err };
}

test("remote lists concrete refs and excludes symbolic heads", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  addRemoteRef(fixture.dir, "origin", "feature");
  addRemoteRef(fixture.dir, "upstream", "feature");
  git(fixture.dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/feature");
  const result = runCli(fixture.dir, ["remote"]); assertExit(result, 0);
  assert.deepEqual(remoteNames(result.stdout), ["origin/feature", "upstream/feature"]);
  assert.doesNotMatch(result.stdout, /origin\/HEAD/);
});

test("remote displays full names and metadata", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  branch(fixture.dir, "old-remote");
  git(fixture.dir, "checkout", "-q", "old-remote");
  commit(fixture.dir, "old.txt", "old\n", "old work", "2020-01-02T03:04:05Z");
  git(fixture.dir, "checkout", "-q", "main");
  addRemoteRef(fixture.dir, "origin", "old-remote", "refs/heads/old-remote");
  const result = runCli(fixture.dir, ["remote"]); assertExit(result, 0);
  assert.match(result.stdout, /^origin\/old-remote \| commit: 2020-01-02T03:04:05\.000Z \| age: \d+ days \| author: Branch Tester \| merged: no$/m);
});

test("remote classifies merged and unmerged refs", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  branch(fixture.dir, "merged-remote");
  branch(fixture.dir, "unmerged-remote");
  git(fixture.dir, "checkout", "-q", "unmerged-remote");
  commit(fixture.dir, "unmerged.txt", "unmerged\n", "unmerged work");
  git(fixture.dir, "checkout", "-q", "main");
  addRemoteRef(fixture.dir, "origin", "merged-remote", "refs/heads/merged-remote");
  addRemoteRef(fixture.dir, "origin", "unmerged-remote", "refs/heads/unmerged-remote");
  const result = runCli(fixture.dir, ["remote"]); assertExit(result, 0);
  assert.match(result.stdout, /^origin\/merged-remote .* \| merged: yes$/m);
  assert.match(result.stdout, /^origin\/unmerged-remote .* \| merged: no$/m);
});

test("remote reports only gone upstreams", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  for (const name of ["none", "tracking", "gone"]) branch(fixture.dir, name);
  configureUpstream(fixture.dir, "tracking", true);
  configureUpstream(fixture.dir, "gone", false);
  const result = runCli(fixture.dir, ["remote"]); assertExit(result, 0);
  assert.deepEqual(missingNames(result.stdout), ["gone"]);
  assert.match(result.stdout, /gone \| upstream: origin\/gone/);
  assert.doesNotMatch(result.stdout, /none \| upstream:/);
  assert.doesNotMatch(result.stdout, /tracking \| upstream:/);
  assert.match(result.stdout, /origin\/tracking .* \| merged: yes/);
});

test("remote has the approved structure and empty sections", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const result = runCli(fixture.dir, ["remote"]); assertExit(result, 0);
  assert.equal(result.stderr, "");
  const repository = result.stdout.indexOf(`Repository: ${repositoryName(fixture.dir)}\n`);
  const base = result.stdout.indexOf("Base branch: main\n", repository);
  const remote = result.stdout.indexOf("Remote branches\n(none)", base);
  const missing = result.stdout.indexOf("Local branches with missing upstream\n(none)", remote);
  assert.ok(repository >= 0 && base > repository && remote > base && missing > remote);
  assert.equal((result.stdout.match(/\(none\)/g) ?? []).length, 2);
});

test("remote honors command and global base precedence", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  branch(fixture.dir, "configured");
  branch(fixture.dir, "explicit");
  writeFileSync(resolve(fixture.dir, ".branch-care.json"), '{"baseBranch":"configured"}\n');
  const command = runCli(fixture.dir, ["remote", "--base", "explicit"]); assertExit(command, 0);
  const global = runCli(fixture.dir, ["--base", "explicit", "remote"]); assertExit(global, 0);
  assert.match(command.stdout, /^Base branch: explicit$/m);
  assert.match(global.stdout, /^Base branch: explicit$/m);
});

test("remote success exits zero", (t) => {
  const populated = makeRepo(); t.after(populated.cleanup); addRemoteRef(populated.dir, "origin", "main");
  const first = runCli(populated.dir, ["remote"]); assertExit(first, 0); assert.equal(first.stderr, "");
  const empty = makeRepo(); t.after(empty.cleanup);
  const second = runCli(empty.dir, ["remote"]); assertExit(second, 0); assert.equal(second.stderr, "");
});

test("remote failures have empty stdout and exit one", async (t) => {
  const outside = makeDirectory(); t.after(outside.cleanup);
  const nonRepo = runCli(outside.dir, ["remote"]); assertExit(nonRepo, 1); assert.equal(nonRepo.stdout, ""); assert.match(nonRepo.stderr, /Not a Git repository/);

  const invalid = makeRepo(); t.after(invalid.cleanup);
  writeFileSync(resolve(invalid.dir, ".branch-care.json"), "{invalid\n");
  const invalidResult = runCli(invalid.dir, ["remote"]); assertExit(invalidResult, 1); assert.equal(invalidResult.stdout, ""); assert.match(invalidResult.stderr, /Invalid repository configuration/);

  const missing = makeRepo("topic"); t.after(missing.cleanup);
  const missingResult = runCli(missing.dir, ["remote"]); assertExit(missingResult, 1); assert.equal(missingResult.stdout, ""); assert.match(missingResult.stderr, /Unable to resolve a base branch/);

  const injected = async (failure: (args: readonly string[]) => boolean, message: string, setup?: (cwd: string) => void): Promise<void> => {
    const fixture = makeRepo(); t.after(fixture.cleanup); setup?.(fixture.dir);
    const runner: GitRunner = async (cwd, args) => {
      if (failure(args)) throw new Error(message);
      return nativeGitRunner(cwd, args);
    };
    const result = await runRepository(new Repository(new GitClient(fixture.dir, runner)));
    assert.equal(result.code, 1);
    assert.deepEqual(result.out, []);
    assert.deepEqual(result.err, [message]);
  };
  await injected((args) => args[0] === "for-each-ref" && args.at(-1) === "refs/remotes/", "remote refs unavailable");
  await injected((args) => args[0] === "for-each-ref" && args.at(-1) === "refs/heads/", "local branches unavailable");
  await injected((args) => args[0] === "merge-base", "ancestry unavailable", (cwd) => addRemoteRef(cwd, "origin", "topic"));
});

test("remote usage failures exit two", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  for (const args of [["remote", "--unknown"], ["remote", "--base"], ["--base"], ["--unknown", "remote"]]) {
    const result = runCli(fixture.dir, args); assertExit(result, 2); assert.equal(result.stdout, ""); assert.match(result.stderr, /Usage:/i);
  }
});

test("remote uses root configuration from nested directories", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  branch(fixture.dir, "configured");
  const nested = resolve(fixture.dir, "one", "two"); mkdirSync(nested, { recursive: true });
  writeFileSync(resolve(fixture.dir, ".branch-care.json"), '{"baseBranch":"configured"}\n');
  const result = runCli(nested, ["remote"]); assertExit(result, 0);
  assert.match(result.stdout, new RegExp(`Repository: ${repositoryName(fixture.dir)}`));
  assert.match(result.stdout, /^Base branch: configured$/m);
});

test("remote is deterministic and uses only read operations", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  branch(fixture.dir, "gone");
  configureUpstream(fixture.dir, "gone", false);
  addRemoteRef(fixture.dir, "origin", "topic");
  const calls: string[][] = [];
  const runner: GitRunner = async (cwd, args) => { calls.push([...args]); return nativeGitRunner(cwd, args); };
  const repository = new Repository(new GitClient(fixture.dir, runner));
  const beforeFiles = snapshotDirectory(fixture.dir);
  const beforeRefs = allRefs(fixture.dir);
  const first = await runRepository(repository);
  const second = await runRepository(repository);
  assert.equal(first.code, 0); assert.equal(second.code, 0);
  assert.deepEqual(first.err, []); assert.deepEqual(second.err, []);
  assert.deepEqual(first.out, second.out);
  assert.doesNotMatch(first.out.join("\n"), /\u001b/);
  assert.equal(snapshotDirectory(fixture.dir), beforeFiles);
  assert.equal(allRefs(fixture.dir), beforeRefs);
  const allowed = new Set(["rev-parse", "for-each-ref", "symbolic-ref", "merge-base"]);
  assert.equal(calls.every((args) => allowed.has(args[0] ?? "")), true, calls.map((args) => args.join(" ")).join("\n"));
  assert.equal(calls.some(([command]) => ["fetch", "prune", "push", "update-ref"].includes(command)), false);
  assert.equal(calls.some(([command, flag]) => command === "branch" && ["-d", "-D"].includes(flag ?? "")), false);
  assert.equal(calls.some(([command, action]) => command === "remote" && ["delete", "remove"].includes(action ?? "")), false);
});

test("remote has no JSON mode", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const result = runCli(fixture.dir, ["remote", "--json"]); assertExit(result, 2);
  assert.equal(result.stdout, ""); assert.match(result.stderr, /Usage:/i);
});
