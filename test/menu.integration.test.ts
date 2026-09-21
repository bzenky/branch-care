import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { menuChoices } from "../src/index.js";
import { assertExit, branch, git, makeDirectory, makeEmptyDirectory, makeRepo, refs, runCli, runCliInteractive, snapshotDirectory, type Fixture } from "./helpers.js";

interface RemoteFixture { local: Fixture; origin: Fixture; cleanup(): void }

function menuInput(index: number): string { return `${"\u001b[B".repeat(index)}\r`; }

function localState(dir: string): string {
  return JSON.stringify({
    files: snapshotDirectory(dir, [".git"]),
    refs: git(dir, "for-each-ref", "--format=%(refname) %(objectname)"),
    config: git(dir, "config", "--local", "--list", "--null")
  });
}

function makeRemote(): RemoteFixture {
  const local = makeRepo(); const origin = makeEmptyDirectory("branch-care-menu-bare-");
  git(origin.dir, "init", "-q", "--bare", "--initial-branch=main");
  git(local.dir, "remote", "add", "origin", origin.dir);
  git(local.dir, "push", "-q", "-u", "origin", "main");
  git(origin.dir, "symbolic-ref", "HEAD", "refs/heads/main");
  git(local.dir, "remote", "set-head", "origin", "-a");
  return { local, origin, cleanup: () => { local.cleanup(); origin.cleanup(); } };
}

function addRemote(fixture: RemoteFixture, name: string): Fixture {
  const bare = makeEmptyDirectory(`branch-care-menu-${name}-`);
  git(bare.dir, "init", "-q", "--bare", "--initial-branch=main");
  git(fixture.local.dir, "remote", "add", name, bare.dir);
  git(fixture.local.dir, "push", "-q", "-u", name, `main:main`);
  git(bare.dir, "symbolic-ref", "HEAD", "refs/heads/main");
  git(fixture.local.dir, "remote", "set-head", name, "-a");
  return bare;
}

function pushBranch(fixture: RemoteFixture, name: string): void {
  git(fixture.local.dir, "push", "-q", "origin", `main:refs/heads/${name}`);
  git(fixture.local.dir, "fetch", "-q", "origin");
}

test("older-than is isolated to explicit clean commands", () => {
  const clean = runCli(process.cwd(), ["clean", "--help"]); assertExit(clean, 0);
  assert.match(clean.stdout, /--older-than <duration>/);
  for (const command of ["status", "remote", "prune", "config"]) {
    const result = runCli(process.cwd(), [command, "--help"]); assertExit(result, 0);
    assert.doesNotMatch(result.stdout, /--older-than/);
  }
  const root = runCli(process.cwd(), ["--help"]); assertExit(root, 0);
  assert.doesNotMatch(root.stdout, /age prompt|older-than.*menu/i);
});

test("interactive bare invocation shows repository context and exact ordered menu", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const result = await runCliInteractive(fixture.dir, [], [{ waitFor: "What do you want to do?", input: menuInput(6) }]);
  assertExit(result, 0);
  assert.match(result.stdout, /Branch Care.*Repository: .*Base branch: main.*What do you want to do\?/s);
  const labels = ["Show local status", "Clean local branches", "Show remote status", "Prune remote-tracking references", "Clean remote branches", "Show repository configuration", "Exit"];
  let cursor = -1; for (const label of labels) { const next = result.stdout.indexOf(label); assert.ok(next > cursor, label); cursor = next; }
  assert.match(result.stdout, /No action was run\./);
});

test("menu context honors base precedence and fails before prompting", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "develop");
  writeFileSync(resolve(fixture.dir, ".branch-care.json"), '{"baseBranch":"main"}\n');
  const explicit = await runCliInteractive(fixture.dir, ["--base", "develop"], [{ waitFor: "What do you want to do?", input: menuInput(6) }]);
  assertExit(explicit, 0); assert.match(explicit.stdout, /Base branch: develop/);
  const missing = await runCliInteractive(fixture.dir, ["--base", "missing"], []);
  assertExit(missing, 1); assert.match(missing.stdout, /Base branch 'missing' does not exist/); assert.doesNotMatch(missing.stdout, /What do you want to do/);
  const outside = makeDirectory(); t.after(outside.cleanup);
  const nonRepo = await runCliInteractive(outside.dir, [], []);
  assertExit(nonRepo, 1); assert.match(nonRepo.stdout, /Not a Git repository/); assert.doesNotMatch(nonRepo.stdout, /What do you want to do/);
});

test("menu delegates local status and configuration once", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const status = await runCliInteractive(fixture.dir, [], [{ waitFor: "What do you want to do?", input: menuInput(0) }]);
  assertExit(status, 0); assert.match(status.stdout, /Current branch/);
  const config = await runCliInteractive(fixture.dir, [], [{ waitFor: "What do you want to do?", input: menuInput(5) }]);
  assertExit(config, 0); assert.match(config.stdout, /"staleAfterDays": 60/);
});

test("menu local clean preserves confirmation cancellation and mutation contracts", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "merged"); const before = refs(fixture.dir);
  const declined = await runCliInteractive(fixture.dir, [], [
    { waitFor: "What do you want to do?", input: menuInput(1) },
    { waitFor: "Branches safe to delete:", input: "\r" },
    { waitFor: "Delete 1 branch?", input: "\r" }
  ]);
  assertExit(declined, 0); assert.match(declined.stdout, /No branches were removed/); assert.equal(refs(fixture.dir), before);
  const confirmed = await runCliInteractive(fixture.dir, [], [
    { waitFor: "What do you want to do?", input: menuInput(1) },
    { waitFor: "Branches safe to delete:", input: "\r" },
    { waitFor: "Delete 1 branch?", input: "y\r" }
  ]);
  assertExit(confirmed, 0); assert.match(confirmed.stdout, /Deleted merged/); assert.doesNotMatch(refs(fixture.dir), /refs\/heads\/merged/);
});

test("menu delegates remote status once without mutation", async (t) => {
  const fixture = makeRemote(); t.after(fixture.cleanup); pushBranch(fixture, "topic"); const before = localState(fixture.local.dir);
  const result = await runCliInteractive(fixture.local.dir, [], [{ waitFor: "What do you want to do?", input: menuInput(2) }]);
  assertExit(result, 0); assert.match(result.stdout, /Remote branches.*origin\/topic/s);
  assert.equal(localState(fixture.local.dir), before);
});

test("menu prune preserves zero and one remote flows", async (t) => {
  const zero = makeRepo(); t.after(zero.cleanup);
  const noRemote = await runCliInteractive(zero.dir, [], [{ waitFor: "What do you want to do?", input: menuInput(3) }]);
  assertExit(noRemote, 0); assert.match(noRemote.stdout, /No remotes are configured/); assert.doesNotMatch(noRemote.stdout, /Select a remote/);
  const one = makeRemote(); t.after(one.cleanup);
  const declined = await runCliInteractive(one.local.dir, [], [
    { waitFor: "What do you want to do?", input: menuInput(3) },
    { waitFor: "Apply fetch and prune for 'origin'?", input: "\r" }
  ]);
  assertExit(declined, 0); assert.match(declined.stdout, /Prune preview: origin.*No refs were changed/s); assert.doesNotMatch(declined.stdout, /Select a remote/);
});

test("menu prune selects one remote before network access", async (t) => {
  const fixture = makeRemote(); const upstream = addRemote(fixture, "upstream"); t.after(() => { fixture.cleanup(); upstream.cleanup(); });
  const before = refs(fixture.local.dir);
  const cancelled = await runCliInteractive(fixture.local.dir, [], [
    { waitFor: "What do you want to do?", input: menuInput(3) },
    { waitFor: "Select a remote:", input: "\u0003" }
  ]);
  assertExit(cancelled, 0); assert.match(cancelled.stdout, /No action was run/); assert.equal(refs(fixture.local.dir), before);
  const selected = await runCliInteractive(fixture.local.dir, [], [
    { waitFor: "What do you want to do?", input: menuInput(3) },
    { waitFor: "Select a remote:", input: "\r" },
    { waitFor: "Apply fetch and prune for 'origin'?", input: "\r" }
  ]);
  assertExit(selected, 0); assert.match(selected.stdout, /Prune preview: origin/); assert.doesNotMatch(selected.stdout, /Prune preview: upstream/);
});

test("menu remote clean preserves zero and one remote flows", async (t) => {
  const zero = makeRepo(); t.after(zero.cleanup);
  const noRemote = await runCliInteractive(zero.dir, [], [{ waitFor: "What do you want to do?", input: menuInput(4) }]);
  assertExit(noRemote, 0); assert.match(noRemote.stdout, /No remotes are configured/); assert.doesNotMatch(noRemote.stdout, /Select a remote/);
  const one = makeRemote(); t.after(one.cleanup); pushBranch(one, "safe");
  const unchecked = await runCliInteractive(one.local.dir, [], [
    { waitFor: "What do you want to do?", input: menuInput(4) },
    { waitFor: "Remote branches safe to delete:", input: "\r" }
  ]);
  assertExit(unchecked, 0); assert.match(unchecked.stdout, /No remote branches were removed/); assert.doesNotMatch(unchecked.stdout, /Select a remote/);
});

test("menu remote clean selects one remote and preserves deletion gates", async (t) => {
  const fixture = makeRemote(); const upstream = addRemote(fixture, "upstream"); t.after(() => { fixture.cleanup(); upstream.cleanup(); }); pushBranch(fixture, "safe");
  const before = git(fixture.origin.dir, "for-each-ref", "--format=%(refname)", "refs/heads");
  const unchanged = (): void => assert.match(git(fixture.origin.dir, "for-each-ref", "--format=%(refname)", "refs/heads"), /refs\/heads\/safe/);
  const unchecked = await runCliInteractive(fixture.local.dir, [], [
    { waitFor: "What do you want to do?", input: menuInput(4) },
    { waitFor: "Select a remote:", input: "\r" },
    { waitFor: "Remote branches safe to delete:", input: "\r" }
  ]);
  assertExit(unchecked, 0); assert.match(unchecked.stdout, /No remote branches were removed/); unchanged();
  const declined = await runCliInteractive(fixture.local.dir, [], [
    { waitFor: "What do you want to do?", input: menuInput(4) },
    { waitFor: "Select a remote:", input: "\r" },
    { waitFor: "Remote branches safe to delete:", input: " \r" },
    { waitFor: "Delete 1 branch from 'origin'?", input: "\r" }
  ]);
  assertExit(declined, 0); assert.match(declined.stdout, /No remote branches were removed/); unchanged();
  const mistyped = await runCliInteractive(fixture.local.dir, [], [
    { waitFor: "What do you want to do?", input: menuInput(4) },
    { waitFor: "Select a remote:", input: "\r" },
    { waitFor: "Remote branches safe to delete:", input: " \r" },
    { waitFor: "Delete 1 branch from 'origin'?", input: "y\r" },
    { waitFor: "Type 'origin' to confirm remote deletion:", input: "wrong\r" }
  ]);
  assertExit(mistyped, 0); assert.match(mistyped.stdout, /No remote branches were removed/); unchanged();
  const deleted = await runCliInteractive(fixture.local.dir, [], [
    { waitFor: "What do you want to do?", input: menuInput(4) },
    { waitFor: "Select a remote:", input: "\r" },
    { waitFor: "Remote branches safe to delete:", input: " \r" },
    { waitFor: "Delete 1 branch from 'origin'?", input: "y\r" },
    { waitFor: "Type 'origin' to confirm remote deletion:", input: "origin\r" }
  ]);
  assertExit(deleted, 0); assert.match(deleted.stdout, /Deleted origin\/safe/);
  const after = git(fixture.origin.dir, "for-each-ref", "--format=%(refname)", "refs/heads");
  assert.match(before, /refs\/heads\/safe/); assert.doesNotMatch(after, /refs\/heads\/safe/); assert.match(after, /refs\/heads\/main/);
});

test("real PTY cancellation covers every installed prompt kind", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "merged"); const before = localState(fixture.dir);
  const exit = await runCliInteractive(fixture.dir, [], [{ waitFor: "What do you want to do?", input: menuInput(6) }]); assertExit(exit, 0); assert.match(exit.stdout, /No action was run/);
  const cancelled = await runCliInteractive(fixture.dir, [], [{ waitFor: "What do you want to do?", input: "\u0003" }]); assertExit(cancelled, 0); assert.match(cancelled.stdout, /No action was run/);
  const cleanCancelled = await runCliInteractive(fixture.dir, [], [
    { waitFor: "What do you want to do?", input: menuInput(1) }, { waitFor: "Branches safe to delete:", input: "\u0003" }
  ]);
  assertExit(cleanCancelled, 0); assert.match(cleanCancelled.stdout, /No branches were removed/);
  assert.equal(localState(fixture.dir), before);

  const remote = makeRemote(); t.after(remote.cleanup); pushBranch(remote, "safe");
  const serverBefore = git(remote.origin.dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
  const pruneCancelled = await runCliInteractive(remote.local.dir, [], [
    { waitFor: "What do you want to do?", input: menuInput(3) },
    { waitFor: "Apply fetch and prune for 'origin'?", input: "\u0003" }
  ]);
  assertExit(pruneCancelled, 0); assert.match(pruneCancelled.stdout, /No refs were changed/);
  const remoteCleanCancelled = await runCliInteractive(remote.local.dir, [], [
    { waitFor: "What do you want to do?", input: menuInput(4) },
    { waitFor: "Remote branches safe to delete:", input: "\u0003" }
  ]);
  assertExit(remoteCleanCancelled, 0); assert.match(remoteCleanCancelled.stdout, /No remote branches were removed/);
  const inputCancelled = await runCliInteractive(remote.local.dir, [], [
    { waitFor: "What do you want to do?", input: menuInput(4) },
    { waitFor: "Remote branches safe to delete:", input: " \r" },
    { waitFor: "Delete 1 branch from 'origin'?", input: "y\r" },
    { waitFor: "Type 'origin' to confirm remote deletion:", input: "\u0003" }
  ]);
  assertExit(inputCancelled, 0); assert.match(inputCancelled.stdout, /No remote branches were removed/);
  assert.equal(git(remote.origin.dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"), serverBefore);

  const selectorRemote = makeRemote(); const selectorUpstream = addRemote(selectorRemote, "upstream");
  t.after(() => { selectorRemote.cleanup(); selectorUpstream.cleanup(); });
  const selectorLocalBefore = localState(selectorRemote.local.dir);
  const selectorOriginBefore = refs(selectorRemote.origin.dir);
  const selectorUpstreamBefore = refs(selectorUpstream.dir);
  const selectorCancelled = await runCliInteractive(selectorRemote.local.dir, [], [
    { waitFor: "What do you want to do?", input: menuInput(3) },
    { waitFor: "Select a remote:", input: "\u0003" }
  ]);
  assertExit(selectorCancelled, 0); assert.match(selectorCancelled.stdout, /No action was run/);
  assert.equal(localState(selectorRemote.local.dir), selectorLocalBefore);
  assert.equal(refs(selectorRemote.origin.dir), selectorOriginBefore);
  assert.equal(refs(selectorUpstream.dir), selectorUpstreamBefore);
});

test("root menu remains unchanged and exposes no undo action", () => {
  assert.deepEqual(menuChoices.map(({ value }) => value), ["status", "clean", "remote", "prune", "remote-clean", "config", "exit"]);
  assert.equal(menuChoices.some(({ name, value }) => /undo/i.test(name) || /undo/i.test(value)), false);
});
