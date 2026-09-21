import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runClean } from "../src/commands/clean.js";
import { GitClient } from "../src/git/client.js";
import { UndoHistory } from "../src/undo-history.js";
import { assertExit, branch, git, makeDirectory, makeEmptyDirectory, makeRepo, refs, runCli, runCliInteractive, snapshotDirectory, type Fixture } from "./helpers.js";

interface RemoteFixture { local: Fixture; server: Fixture; cleanup(): void }
function makeRemote(): RemoteFixture {
  const local = makeRepo(); const server = makeEmptyDirectory("branch-care-contract-server-"); git(server.dir, "init", "-q", "--bare", "--initial-branch=main");
  git(local.dir, "remote", "add", "origin", server.dir); git(local.dir, "push", "-q", "-u", "origin", "main"); git(server.dir, "symbolic-ref", "HEAD", "refs/heads/main"); git(local.dir, "remote", "set-head", "origin", "-a");
  return { local, server, cleanup: () => { local.cleanup(); server.cleanup(); } };
}
function pushRemote(fixture: RemoteFixture, name: string): void { git(fixture.local.dir, "push", "-q", "origin", `main:refs/heads/${name}`); git(fixture.local.dir, "fetch", "-q", "origin"); }
async function completeState(local: string, server?: string): Promise<string> {
  const history = new UndoHistory(new GitClient(local)); const paths = await history.paths();
  return JSON.stringify({ worktree: snapshotDirectory(local, [".git"]), index: git(local, "ls-files", "--stage"), head: git(local, "rev-parse", "HEAD"), headRef: git(local, "symbolic-ref", "-q", "HEAD"), config: git(local, "config", "--local", "--list"), localRefs: git(local, "for-each-ref", "--format=%(refname) %(objectname)"), serverRefs: server ? git(server, "for-each-ref", "--format=%(refname) %(objectname)") : "", recovery: existsSync(paths.root) ? snapshotDirectory(paths.root) : undefined });
}

test("public command success and no-op stream matrix", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "develop");
  for (const [name, args] of [["root help", ["--help"]], ["version", ["--version"]], ["status", ["status"]], ["status JSON", ["status", "--json"]], ["remote", ["remote"]], ["config inspect", ["config"]], ["config update", ["config", "--base", "develop"]], ["prune preview", ["prune", "--dry-run"]], ["local cleanup preview", ["clean", "--dry-run"]], ["remote cleanup preview", ["clean", "--remote", "--dry-run"]], ["undo list", ["undo", "--list"]]] as const) {
    const result = runCli(fixture.dir, [...args]); assertExit(result, 0); assert.notEqual(result.stdout, "", name); assert.equal(result.stderr, "", name);
  }
  const menu = await runCliInteractive(fixture.dir, [], [{ waitFor: "What do you want to do?", input: "\u001b[B\u001b[B\u001b[B\u001b[B\u001b[B\u001b[B\r" }]); assertExit(menu, 0); assert.match(menu.stdout, /No action was run/); assert.equal(menu.stderr, "");
  {
    const remote = makeRemote(); t.after(remote.cleanup); const prune = await runCliInteractive(remote.local.dir, ["prune", "--remote", "origin"], [{ waitFor: "Apply fetch and prune for 'origin'?", input: "y\r" }]); assertExit(prune, 0); assert.match(prune.stdout, /Pruned remote 'origin'/); assert.equal(prune.stderr, "");
  }
  {
    const local = makeRepo(); t.after(local.cleanup); branch(local.dir, "topic"); const clean = await runCliInteractive(local.dir, ["clean"], [{ waitFor: "Branches safe to delete:", input: "\r" }, { waitFor: "Delete 1 branch?", input: "y\r" }]); assertExit(clean, 0); assert.match(clean.stdout, /Deleted topic/); assert.equal(clean.stderr, ""); const id = clean.stdout.match(/clean-\d{8}T\d{6}Z-[0-9a-f]+/)![0];
    const listed = runCli(local.dir, ["undo", "--list"]); assertExit(listed, 0); assert.match(listed.stdout, new RegExp(id)); assert.equal(listed.stderr, "");
    const restored = await runCliInteractive(local.dir, ["undo", id], [{ waitFor: "Restore 1 branch?", input: "y\r" }]); assertExit(restored, 0); assert.match(restored.stdout, /Restored topic/); assert.equal(restored.stderr, "");
  }
  {
    const local = makeRepo(); t.after(local.cleanup); branch(local.dir, "topic"); const clean = await runCliInteractive(local.dir, ["clean"], [{ waitFor: "Branches safe to delete:", input: "\r" }, { waitFor: "Delete 1 branch?", input: "y\r" }]); const id = clean.stdout.match(/clean-\d{8}T\d{6}Z-[0-9a-f]+/)![0];
    const discarded = await runCliInteractive(local.dir, ["undo", "--discard", id], [{ waitFor: "Permanently discard recovery", input: "y\r" }]); assertExit(discarded, 0); assert.match(discarded.stdout, /Discarded/); assert.equal(discarded.stderr, "");
  }
  {
    const remote = makeRemote(); t.after(remote.cleanup); pushRemote(remote, "topic"); const clean = await runCliInteractive(remote.local.dir, ["clean", "--remote", "origin"], [{ waitFor: "Remote branches safe to delete:", input: " \r" }, { waitFor: "Delete 1 branch from 'origin'?", input: "y\r" }, { waitFor: "Type 'origin' to confirm remote deletion:", input: "origin\r" }]); assertExit(clean, 0); assert.match(clean.stdout, /Deleted origin\/topic/); assert.equal(clean.stderr, "");
  }
  {
    const local = makeRepo(); t.after(local.cleanup); branch(local.dir, "topic"); const noop = await runCliInteractive(local.dir, ["clean"], [{ waitFor: "Branches safe to delete:", input: "\r" }, { waitFor: "Delete 1 branch?", input: "\r" }]); assertExit(noop, 0); assert.match(noop.stdout, /No branches were removed/); assert.equal(noop.stderr, "");
  }
});

test("public command operational failure stream matrix", async (t) => {
  const directory = makeDirectory(); t.after(directory.cleanup);
  const root = await runCliInteractive(directory.dir, [], []); assertExit(root, 1); assert.match(root.stdout, /Not a Git repository/); assert.equal(root.stderr, "");
  for (const args of [["status"], ["status", "--json"], ["remote"], ["config"], ["prune", "--dry-run"], ["clean", "--dry-run"], ["clean", "--remote", "--dry-run"], ["undo", "--list"], ["prune"], ["clean"], ["clean", "--remote"], ["undo"], ["undo", "--discard", "clean-20260102T030405Z-a1"]]) {
    const result = runCli(directory.dir, args); assertExit(result, 1); assert.equal(result.stdout, "", args.join(" ")); assert.notEqual(result.stderr, "", args.join(" "));
  }
  const out: string[] = []; const err: string[] = []; const promptFailure = await runClean({ repository: { analyze: async () => ({ repositoryName: "repo", baseBranch: "main", currentBranch: "main", branches: [{ name: "topic", commitTimestamp: new Date(0), ageDays: 1, author: "A", upstream: undefined, isCurrent: false, isMerged: true, isStale: true, isProtected: false, isCandidate: true }] }), revalidate: async () => ({ eligible: true }), deleteBranch: async () => {} }, prompts: { select: async () => { throw new Error("prompt transport failed"); }, confirm: async () => false }, output: { out: (line) => out.push(line), err: (line) => err.push(line) }, dryRun: false, interactive: true });
  assert.equal(promptFailure, 1); assert.equal(out.join(""), ""); assert.deepEqual(err, ["prompt transport failed"]);
});

test("partial local mutation separates progress diagnostics and retry state", async () => {
  const out: string[] = []; const err: string[] = [];
  const code = await runClean({
    repository: {
      analyze: async () => ({ repositoryName: "repo", baseBranch: "main", currentBranch: "main", branches: ["alpha", "zeta"].map((name) => ({ name, commitTimestamp: new Date(0), ageDays: 100, author: "A", upstream: undefined, isCurrent: false, isMerged: true, isStale: true, isProtected: false, isCandidate: true })) }),
      revalidate: async () => ({ eligible: true }), branchOid: async () => "a".repeat(40),
      deleteBranch: async (name) => { if (name === "zeta") throw new Error("injected deletion failure"); }
    },
    prompts: { select: async () => ["alpha", "zeta"], confirm: async () => true },
    output: { out: (line) => out.push(line), err: (line) => err.push(line) }, dryRun: false, interactive: true
  });
  assert.equal(code, 1); assert.match(out.join("\n"), /Deleted alpha.*Deleted 1 branch\./s);
  assert.match(err.join("\n"), /Failed zeta: injected deletion failure/);
});

test("public usage error matrix rejects before all work", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const before = refs(fixture.dir);
  const cases = [["unknown"], ["status", "--base"], ["clean", "--older-than", "0d"], ["undo", "bad-id"], ["undo", "--list", "clean-20260102T030405Z-a1"]];
  for (const args of cases) { const result = runCli(fixture.dir, args); assertExit(result, 2); assert.equal(result.stdout, ""); assert.match(result.stderr, /Usage:|invalid|mutually exclusive/i); }
  assert.equal(refs(fixture.dir), before);
});

test("standalone cleanup and prune PTY cancellation boundaries are no-ops", async (t) => {
  for (const boundary of ["local selection", "local confirmation"] as const) {
    const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "topic"); const before = await completeState(fixture.dir);
    const interactions = boundary === "local selection" ? [{ waitFor: "Branches safe to delete:", input: "\u0003" }] : [{ waitFor: "Branches safe to delete:", input: "\r" }, { waitFor: "Delete 1 branch?", input: "\u0003" }];
    const result = await runCliInteractive(fixture.dir, ["clean"], interactions); assertExit(result, 0); assert.match(result.stdout, /No branches were removed/); assert.equal(await completeState(fixture.dir), before, boundary);
  }
  {
    const fixture = makeRemote(); t.after(fixture.cleanup); const before = await completeState(fixture.local.dir, fixture.server.dir);
    const result = await runCliInteractive(fixture.local.dir, ["prune", "--remote", "origin"], [{ waitFor: "Apply fetch and prune for 'origin'?", input: "\u0003" }]);
    assertExit(result, 0); assert.match(result.stdout, /No refs were changed/); assert.equal(await completeState(fixture.local.dir, fixture.server.dir), before, "prune confirmation");
  }
  for (const boundary of ["remote selection", "remote confirmation", "remote input"] as const) {
    const fixture = makeRemote(); t.after(fixture.cleanup); pushRemote(fixture, "topic"); const before = await completeState(fixture.local.dir, fixture.server.dir);
    const interactions = boundary === "remote selection" ? [{ waitFor: "Remote branches safe to delete:", input: "\u0003" }] : boundary === "remote confirmation" ? [{ waitFor: "Remote branches safe to delete:", input: " \r" }, { waitFor: "Delete 1 branch from 'origin'?", input: "\u0003" }] : [{ waitFor: "Remote branches safe to delete:", input: " \r" }, { waitFor: "Delete 1 branch from 'origin'?", input: "y\r" }, { waitFor: "Type 'origin' to confirm remote deletion:", input: "\u0003" }];
    const result = await runCliInteractive(fixture.local.dir, ["clean", "--remote", "origin"], interactions); assertExit(result, 0); assert.match(result.stdout, /No remote branches were removed/); assert.equal(await completeState(fixture.local.dir, fixture.server.dir), before, boundary);
  }
});

test("standalone undo PTY cancellation boundaries preserve recovery", async (t) => {
  for (const boundary of ["local confirm", "discard confirm"] as const) {
    const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "topic");
    const created = await runCliInteractive(fixture.dir, ["clean"], [{ waitFor: "Branches safe to delete:", input: "\r" }, { waitFor: "Delete 1 branch?", input: "y\r" }]); assertExit(created, 0);
    const id = created.stdout.match(/clean-\d{8}T\d{6}Z-[0-9a-f]+/)![0]; writeFileSync(resolve(fixture.dir, "untracked.txt"), "unchanged\n"); git(fixture.dir, "config", "branch-care.test", "unchanged"); const before = await completeState(fixture.dir);
    const args = boundary === "discard confirm" ? ["undo", "--discard", id] : ["undo", id]; const prompt = boundary === "discard confirm" ? "Permanently discard recovery" : "Restore 1 branch?";
    const result = await runCliInteractive(fixture.dir, args, [{ waitFor: prompt, input: "\u0003" }]); assertExit(result, 0); assert.match(result.stdout, boundary === "discard confirm" ? /Recovery was not discarded/ : /No branches were restored/); assert.equal(await completeState(fixture.dir), before, boundary);
  }
  for (const boundary of ["remote confirm", "remote input"] as const) {
    const fixture = makeRemote(); t.after(fixture.cleanup); pushRemote(fixture, "topic");
    const created = await runCliInteractive(fixture.local.dir, ["clean", "--remote", "origin"], [{ waitFor: "Remote branches safe to delete:", input: " \r" }, { waitFor: "Delete 1 branch from 'origin'?", input: "y\r" }, { waitFor: "Type 'origin' to confirm remote deletion:", input: "origin\r" }]); assertExit(created, 0);
    const id = created.stdout.match(/clean-\d{8}T\d{6}Z-[0-9a-f]+/)![0]; writeFileSync(resolve(fixture.local.dir, "untracked.txt"), "unchanged\n"); git(fixture.local.dir, "config", "branch-care.test", "unchanged"); const before = await completeState(fixture.local.dir, fixture.server.dir);
    const interactions = boundary === "remote confirm" ? [{ waitFor: "Restore 1 branch?", input: "\u0003" }] : [{ waitFor: "Restore 1 branch?", input: "y\r" }, { waitFor: "Type 'origin' to confirm remote restoration:", input: "\u0003" }];
    const result = await runCliInteractive(fixture.local.dir, ["undo", id], interactions); assertExit(result, 0); assert.match(result.stdout, /No branches were restored/); assert.equal(await completeState(fixture.local.dir, fixture.server.dir), before, boundary);
  }
});
