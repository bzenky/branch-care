import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { runClean } from "../src/commands/clean.js";
import { GitClient } from "../src/git/client.js";
import { Repository } from "../src/git/repository.js";
import { assertExit, branch, git, makeDirectory, makeRepo, refs, runCli, runCliInteractive, snapshotDirectory } from "./helpers.js";

function prepareCandidates(): ReturnType<typeof makeRepo> {
  const fixture = makeRepo();
  branch(fixture.dir, "zeta"); branch(fixture.dir, "alpha"); branch(fixture.dir, "release/1");
  git(fixture.dir, "checkout", "-q", "-b", "unmerged");
  writeFileSync(`${fixture.dir}/work.txt`, "work");
  git(fixture.dir, "add", "work.txt"); git(fixture.dir, "commit", "-q", "-m", "work"); git(fixture.dir, "checkout", "-q", "main");
  return fixture;
}

test("dry-run prints the exact candidate set", (t) => {
  const fixture = prepareCandidates(); t.after(fixture.cleanup);
  const result = runCli(fixture.dir, ["clean", "--dry-run"]); assertExit(result, 0);
  assert.match(result.stdout, /Would delete:\nalpha\nzeta\n/);
  assert.doesNotMatch(result.stdout, /release\/1\nunmerged/);
});

test("local older-than dry-run filters safe candidates inclusively", async () => {
  const lines: string[] = [];
  const branches = [
    { name: "zeta", ageDays: 30, isCandidate: true },
    { name: "alpha", ageDays: 31, isCandidate: true },
    { name: "young", ageDays: 29, isCandidate: true },
    { name: "unmerged-old", ageDays: 100, isCandidate: false }
  ].map((branch) => ({ ...branch, commitTimestamp: new Date(0), author: "A", upstream: undefined, isCurrent: false, isMerged: branch.name !== "unmerged-old", isStale: true, isProtected: false }));
  const code = await runClean({
    repository: {
      analyze: async () => ({ repositoryName: "repo", baseBranch: "main", currentBranch: "main", branches }),
      revalidate: async () => ({ eligible: true }), deleteBranch: async () => {}
    },
    prompts: { select: async () => [], confirm: async () => false },
    output: { out: (line) => lines.push(line), err: (line) => lines.push(`ERR:${line}`) },
    dryRun: true, interactive: false, olderThanDays: 30
  });
  assert.equal(code, 0);
  assert.equal(lines.join("\n"), "Older than: 30d\nDry run\n\nWould delete:\nalpha\nzeta\n\nNo branches were removed.");
});

test("local older-than empty result is a zero-exit no-op", async () => {
  const lines: string[] = []; let prompts = 0; let mutations = 0;
  const code = await runClean({
    repository: {
      analyze: async () => ({ repositoryName: "repo", baseBranch: "main", currentBranch: "main", branches: [] }),
      revalidate: async () => ({ eligible: true }), deleteBranch: async () => { mutations += 1; }
    },
    prompts: { select: async () => { prompts += 1; return []; }, confirm: async () => { prompts += 1; return false; } },
    output: { out: (line) => lines.push(line), err: (line) => lines.push(`ERR:${line}`) },
    dryRun: false, interactive: true, olderThanDays: 30
  });
  assert.equal(code, 0); assert.equal(prompts, 0); assert.equal(mutations, 0);
  assert.deepEqual(lines, ["Older than: 30d", "No branches are safe to delete."]);
});

test("dry-run preserves every local ref", (t) => {
  const fixture = prepareCandidates(); t.after(fixture.cleanup); const before = refs(fixture.dir);
  assertExit(runCli(fixture.dir, ["clean", "--dry-run"]), 0);
  assert.equal(refs(fixture.dir), before);
});

test("dry-run candidate result exits zero", (t) => {
  const fixture = prepareCandidates(); t.after(fixture.cleanup);
  const result = runCli(fixture.dir, ["clean", "--dry-run"]); assertExit(result, 0);
  assert.match(result.stdout, /No branches were removed\./);
});

test("dry-run empty result exits zero", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const result = runCli(fixture.dir, ["clean", "--dry-run"]); assertExit(result, 0);
  assert.equal(result.stdout.trim(), "No branches are safe to delete.");
});

test("dry-run rejects detached head without mutation", (t) => {
  const fixture = prepareCandidates(); t.after(fixture.cleanup); git(fixture.dir, "checkout", "-q", "--detach", "HEAD"); const before = refs(fixture.dir);
  const result = runCli(fixture.dir, ["clean", "--dry-run"]); assertExit(result, 1);
  assert.match(result.stderr, /Cleanup requires an attached current branch/); assert.equal(refs(fixture.dir), before);
});

test("dry-run failure parity covers repository and base errors", (t) => {
  const directory = makeDirectory(); const repository = makeRepo("topic"); t.after(directory.cleanup); t.after(repository.cleanup);
  const directoryBefore = snapshotDirectory(directory.dir);
  const statusNonRepo = runCli(directory.dir, ["status"]); const cleanNonRepo = runCli(directory.dir, ["clean", "--dry-run"]);
  assert.equal(cleanNonRepo.stderr, statusNonRepo.stderr); assert.equal(cleanNonRepo.status, statusNonRepo.status);
  assert.equal(snapshotDirectory(directory.dir), directoryBefore);
  const before = refs(repository.dir); const statusBase = runCli(repository.dir, ["status"]); const cleanBase = runCli(repository.dir, ["clean", "--dry-run"]);
  assert.equal(cleanBase.stderr, statusBase.stderr); assert.equal(cleanBase.status, statusBase.status); assert.equal(refs(repository.dir), before);
});

test("local cleanup no-op table preserves every repository and recovery surface", async (t) => {
  const fixture = prepareCandidates(); t.after(fixture.cleanup); const before = refs(fixture.dir);
  for (const prompts of [
    { select: async () => ["alpha"], confirm: async () => false },
    { select: async (): Promise<string[]> => { throw Object.assign(new Error("cancelled"), { name: "ExitPromptError" }); }, confirm: async () => false }
  ]) {
    const lines: string[] = [];
    const code = await runClean({ repository: new Repository(new GitClient(fixture.dir)), prompts, output: { out: (line) => lines.push(line), err: (line) => lines.push(line) }, dryRun: false, interactive: true });
    assert.equal(code, 0); assert.match(lines.join("\n"), /No branches were removed\./); assert.equal(refs(fixture.dir), before);
  }

  const declined = await runCliInteractive(fixture.dir, ["clean"], [
    { waitFor: "Branches safe to delete:", input: "\r" },
    { waitFor: "Delete 2 branches?", input: "\r" }
  ]);
  assertExit(declined, 0);
  assert.match(declined.stdout, /No branches were removed\./);
  assert.equal(refs(fixture.dir), before);

  const cancelled = await runCliInteractive(fixture.dir, ["clean"], [
    { waitFor: "Branches safe to delete:", input: "\u0003" }
  ]);
  assertExit(cancelled, 0);
  assert.match(cancelled.stdout, /No branches were removed\./);
  assert.equal(refs(fixture.dir), before);
});

test("complete cleanup reports names count and zero", async (t) => {
  const fixture = prepareCandidates(); t.after(fixture.cleanup); const lines: string[] = [];
  const code = await runClean({ repository: new Repository(new GitClient(fixture.dir)), prompts: { select: async () => ["alpha", "zeta"], confirm: async () => true }, output: { out: (line) => lines.push(line), err: (line) => lines.push(line) }, dryRun: false, interactive: true });
  assert.equal(code, 0); assert.match(lines.join("\n"), /Deleted alpha/); assert.match(lines.join("\n"), /Deleted zeta/); assert.match(lines.join("\n"), /Deleted 2 branches\./);
  assert.doesNotMatch(refs(fixture.dir), /refs\/heads\/(alpha|zeta)/);

  const processFixture = prepareCandidates(); t.after(processFixture.cleanup);
  const result = await runCliInteractive(processFixture.dir, ["clean"], [
    { waitFor: "Branches safe to delete:", input: "\r" },
    { waitFor: "Delete 2 branches?", input: "y\r" }
  ]);
  assertExit(result, 0);
  assert.match(result.stdout, /Deleted alpha/);
  assert.match(result.stdout, /Deleted zeta/);
  assert.match(result.stdout, /Deleted 2 branches\./);
  assert.doesNotMatch(refs(processFixture.dir), /refs\/heads\/(alpha|zeta)/);
});

test("local cleanup records exactly successful deletions for undo", async (t) => {
  const fixture = prepareCandidates(); t.after(fixture.cleanup); const client = new GitClient(fixture.dir); const repository = new Repository(client); const { UndoHistory } = await import("../src/undo-history.js"); const history = new UndoHistory(client); const lines: string[] = [];
  const code = await runClean({ repository, history, prompts: { select: async () => ["alpha", "unmerged", "zeta"], confirm: async () => true }, output: { out: (line) => lines.push(line), err: (line) => lines.push(`ERR:${line}`) }, dryRun: false, interactive: true });
  assert.equal(code, 1); const [operation] = await history.list(); assert.deepEqual(operation!.entries.map(({ name }) => name), ["alpha", "zeta"]); for (const entry of operation!.entries) assert.equal(git(fixture.dir, "rev-parse", entry.backupRef), entry.oid); assert.match(lines.join("\n"), new RegExp(`Rollback ID: ${operation!.id}[\\s\\S]*branch-care undo ${operation!.id}`));
});

test("non-interactive cleanup is rejected", (t) => {
  const fixture = prepareCandidates(); t.after(fixture.cleanup); const before = refs(fixture.dir);
  const result = runCli(fixture.dir, ["clean"]); assertExit(result, 1);
  assert.match(result.stderr, /Interactive selection is required\./); assert.equal(refs(fixture.dir), before);
});
