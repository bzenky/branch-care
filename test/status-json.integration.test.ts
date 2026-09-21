import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import test from "node:test";
import { branch, commit, git, makeDirectory, makeRepo, runCli, assertExit, snapshotDirectory } from "./helpers.js";

interface JsonBranch {
  name: string; lastCommitAt: string; daysSinceLastCommit: number; author: string; upstream: string | null;
  upstreamState: "none" | "tracking" | "gone"; isCurrent: boolean; isMerged: boolean; isStale: boolean;
  isProtected: boolean; isDeletionCandidate: boolean;
}
interface JsonStatus {
  schemaVersion: number; repository: string; baseBranch: { name: string; source: string }; currentBranch: string | null;
  detachedHead: boolean; staleAfterDays: number; branches: JsonBranch[];
}
function jsonStatus(cwd: string, extra: string[] = []): { result: ReturnType<typeof runCli>; document: JsonStatus } {
  const result = runCli(cwd, ["status", "--json", ...extra]);
  assertExit(result, 0);
  assert.equal(result.stderr, "");
  return { result, document: JSON.parse(result.stdout) as JsonStatus };
}
function configureUpstream(cwd: string, name: string, exists: boolean): void {
  git(cwd, "config", "remote.origin.url", "https://example.test/repository.git");
  git(cwd, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git(cwd, "config", `branch.${name}.remote`, "origin");
  git(cwd, "config", `branch.${name}.merge`, `refs/heads/${name}`);
  if (exists) git(cwd, "update-ref", `refs/remotes/origin/${name}`, `refs/heads/${name}`);
}
function humanGroupNames(output: string, title: string): string[] {
  const start = output.indexOf(`${title}\n`) + title.length + 1;
  const end = output.indexOf("\n\n", start);
  return output.slice(start, end < 0 ? undefined : end)
    .split("\n")
    .filter((line) => line.includes(" | commit: "))
    .map((line) => line.slice(0, line.indexOf(" | commit: ")));
}

test("JSON status has exact top-level schema", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const { document } = jsonStatus(fixture.dir);
  assert.deepEqual(Object.keys(document), ["schemaVersion", "repository", "baseBranch", "currentBranch", "detachedHead", "staleAfterDays", "branches"]);
});

test("JSON repository is root basename", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const nested = resolve(fixture.dir, "one", "two"); mkdirSync(nested, { recursive: true });
  assert.equal(jsonStatus(fixture.dir).document.repository, basename(fixture.dir));
  assert.equal(jsonStatus(nested).document.repository, basename(fixture.dir));
});

test("JSON base source covers all six precedence winners", (t) => {
  const cli = makeRepo(); t.after(cli.cleanup); branch(cli.dir, "topic");
  assert.deepEqual(jsonStatus(cli.dir, ["--base", "topic"]).document.baseBranch, { name: "topic", source: "cli" });

  const configured = makeRepo(); t.after(configured.cleanup); branch(configured.dir, "topic");
  writeFileSync(resolve(configured.dir, ".branch-care.json"), '{"baseBranch":"topic"}\n');
  assert.deepEqual(jsonStatus(configured.dir).document.baseBranch, { name: "topic", source: "repository" });

  const origin = makeRepo("trunk"); t.after(origin.cleanup);
  git(origin.dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  assert.deepEqual(jsonStatus(origin.dir).document.baseBranch, { name: "trunk", source: "originHead" });

  for (const name of ["main", "master", "develop"] as const) {
    const fixture = makeRepo(name); t.after(fixture.cleanup);
    assert.deepEqual(jsonStatus(fixture.dir).document.baseBranch, { name, source: name });
  }
});

test("JSON attached head has name and false flag", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const document = jsonStatus(fixture.dir).document;
  assert.equal(document.currentBranch, "main"); assert.equal(document.detachedHead, false);
});

test("JSON detached head has null and true flag", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); git(fixture.dir, "checkout", "-q", "--detach", "HEAD");
  const document = jsonStatus(fixture.dir).document;
  assert.equal(document.currentBranch, null); assert.equal(document.detachedHead, true);
});

test("JSON reports configured stale threshold", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  writeFileSync(resolve(fixture.dir, ".branch-care.json"), '{"staleAfterDays":17}\n');
  assert.equal(jsonStatus(fixture.dir).document.staleAfterDays, 17);
});

test("JSON commit time and age match human status", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "topic");
  const document = jsonStatus(fixture.dir).document;
  const topic = document.branches.find(({ name }) => name === "topic")!;
  assert.equal(new Date(topic.lastCommitAt).toISOString(), topic.lastCommitAt);
  const human = runCli(fixture.dir, ["status"]); assertExit(human, 0);
  assert.ok(human.stdout.includes(`topic | commit: ${topic.lastCommitAt} | age: ${topic.daysSinceLastCommit} days`));
});

test("JSON upstream pairs cover all states", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  branch(fixture.dir, "none"); branch(fixture.dir, "tracking"); branch(fixture.dir, "gone");
  configureUpstream(fixture.dir, "tracking", true); configureUpstream(fixture.dir, "gone", false);
  const byName = new Map(jsonStatus(fixture.dir).document.branches.map((item) => [item.name, item]));
  assert.deepEqual([byName.get("none")?.upstream, byName.get("none")?.upstreamState], [null, "none"]);
  assert.deepEqual([byName.get("tracking")?.upstream, byName.get("tracking")?.upstreamState], ["origin/tracking", "tracking"]);
  assert.deepEqual([byName.get("gone")?.upstream, byName.get("gone")?.upstreamState], ["origin/gone", "gone"]);
});

test("JSON stdout formatting is deterministic and clean", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const first = jsonStatus(fixture.dir).result.stdout; const second = jsonStatus(fixture.dir).result.stdout;
  assert.equal(first, second); assert.equal(first, `${JSON.stringify(JSON.parse(first), null, 2)}\n`);
  assert.equal((first.match(/\n+$/)?.[0] ?? "").length, 1);
  assert.doesNotMatch(first, /\u001b/); assert.doesNotMatch(first, /Repository:|Merged branches/);
});

test("JSON and human status share configured analysis", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  branch(fixture.dir, "merged-topic"); branch(fixture.dir, "team/topic");
  git(fixture.dir, "checkout", "-q", "-b", "stale-topic");
  commit(fixture.dir, "stale.txt", "old work\n", "old work", "2020-01-01T00:00:00Z");
  git(fixture.dir, "checkout", "-q", "main");
  configureUpstream(fixture.dir, "merged-topic", true);
  configureUpstream(fixture.dir, "team/topic", false);
  writeFileSync(resolve(fixture.dir, ".branch-care.json"), '{"baseBranch":"main","staleAfterDays":1,"protectedBranches":["team/*"]}\n');

  const document = jsonStatus(fixture.dir).document;
  const human = runCli(fixture.dir, ["status"]); assertExit(human, 0);
  assert.deepEqual(document.baseBranch, { name: "main", source: "repository" });
  assert.equal(document.staleAfterDays, 1);
  assert.match(human.stdout, /^Base branch: main$/m);
  assert.match(human.stdout, /^Current branch\n→ main$/m);

  const mergedNames = humanGroupNames(human.stdout, "Merged branches");
  const staleNames = humanGroupNames(human.stdout, "Stale branches");
  const protectedNames = humanGroupNames(human.stdout, "Protected branches");
  assert.deepEqual(mergedNames, document.branches.filter((item) => item.isMerged && !item.isProtected).map(({ name }) => name));
  assert.deepEqual(staleNames, document.branches.filter((item) => item.isStale).map(({ name }) => name));
  assert.deepEqual(protectedNames, document.branches.filter((item) => item.isProtected).map(({ name }) => name));

  for (const item of document.branches) {
    const metadata = `${item.name} | commit: ${item.lastCommitAt} | age: ${item.daysSinceLastCommit} days | author: ${item.author} | upstream: ${item.upstream ?? "none"} | upstream state: ${item.upstreamState}`;
    assert.ok(human.stdout.includes(metadata), `human status must expose shared metadata for ${item.name}`);
    assert.equal(item.isCurrent, item.name === "main", `current parity for ${item.name}`);
    assert.equal(item.isDeletionCandidate, mergedNames.includes(item.name) && !item.isCurrent && !item.isProtected, `candidate parity for ${item.name}`);
  }
  assert.equal(document.branches.find(({ name }) => name === "stale-topic")?.isStale, true);
  assert.equal(document.branches.find(({ name }) => name === "team/topic")?.isProtected, true);
});

test("JSON failures preserve empty stdout and distinct exit classes", (t) => {
  const usageFixture = makeRepo(); t.after(usageFixture.cleanup);
  const usage = runCli(usageFixture.dir, ["status", "--json", "--unknown"]); assertExit(usage, 2); assert.equal(usage.stdout, ""); assert.match(usage.stderr, /Usage:/);
});

test("JSON failures use empty stdout and existing stderr", (t) => {
  const outside = makeDirectory(); t.after(outside.cleanup);
  const nonRepo = runCli(outside.dir, ["status", "--json"]); assertExit(nonRepo, 1); assert.equal(nonRepo.stdout, ""); assert.match(nonRepo.stderr, /Not a Git repository/);

  const invalid = makeRepo(); t.after(invalid.cleanup); writeFileSync(resolve(invalid.dir, ".branch-care.json"), "{invalid\n");
  const invalidResult = runCli(invalid.dir, ["status", "--json"]); assertExit(invalidResult, 1); assert.equal(invalidResult.stdout, ""); assert.match(invalidResult.stderr, /Invalid repository configuration/);

  const missing = makeRepo("topic"); t.after(missing.cleanup);
  const missingResult = runCli(missing.dir, ["status", "--json"]); assertExit(missingResult, 1); assert.equal(missingResult.stdout, ""); assert.match(missingResult.stderr, /Unable to resolve a base branch/);

  const corrupt = makeRepo(); t.after(corrupt.cleanup); writeFileSync(resolve(corrupt.dir, ".git", "refs", "heads", "broken"), "0000000000000000000000000000000000000001\n");
  const corruptResult = runCli(corrupt.dir, ["status", "--json"]); assertExit(corruptResult, 1); assert.equal(corruptResult.stdout, "");
  assert.equal(corruptResult.stderr, "fatal: missing object 0000000000000000000000000000000000000001 for refs/heads/broken\n");
});

test("JSON usage failures emit no document", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  for (const args of [["status", "--json", "--unknown"], ["status", "--json", "--base"]]) {
    const result = runCli(fixture.dir, args); assertExit(result, 2); assert.equal(result.stdout, ""); assert.match(result.stderr, /Usage:/i);
  }
});

test("JSON includes all local branches without topics", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const branches = jsonStatus(fixture.dir).document.branches;
  assert.deepEqual(branches.map(({ name }) => name), ["main"]); assert.equal(branches[0]?.isCurrent, true); assert.equal(branches[0]?.isProtected, true);
});

test("JSON status preserves repository snapshot", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "topic"); configureUpstream(fixture.dir, "topic", true);
  writeFileSync(resolve(fixture.dir, "untracked.txt"), "unchanged\n");
  const before = snapshotDirectory(fixture.dir); jsonStatus(fixture.dir); assert.equal(snapshotDirectory(fixture.dir), before);
  writeFileSync(resolve(fixture.dir, ".branch-care.json"), "{invalid\n");
  const failedBefore = snapshotDirectory(fixture.dir); const failed = runCli(fixture.dir, ["status", "--json"]); assertExit(failed, 1);
  assert.equal(snapshotDirectory(fixture.dir), failedBefore);
});
