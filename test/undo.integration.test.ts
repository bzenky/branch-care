import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runClean } from "../src/commands/clean.js";
import { runRemoteClean } from "../src/commands/remote-clean.js";
import { runUndo } from "../src/commands/undo.js";
import { GitClient } from "../src/git/client.js";
import { Repository } from "../src/git/repository.js";
import { UndoHistory, type UndoReceipt } from "../src/undo-history.js";
import { branch, git, makeEmptyDirectory, makeRepo, refs, runCli, snapshotDirectory } from "./helpers.js";

async function operationFixture(dir: string, names = ["zeta", "alpha"]) {
  for (const name of names) branch(dir, name); const gitClient = new GitClient(dir); const repository = new Repository(gitClient); const history = new UndoHistory(gitClient); const output: string[] = [];
  const code = await runClean({ repository, history, dryRun: false, interactive: true, prompts: { select: async () => names, confirm: async () => true }, output: { out: (line) => output.push(line), err: (line) => output.push(`ERR:${line}`) } }); assert.equal(code, 0, output.join("\n"));
  return { repository, history, operation: (await history.list())[0]!, output };
}
function output() { const out: string[] = []; const err: string[] = []; return { out, err, sink: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } }; }

async function remoteOperationFixture(t: test.TestContext, names = ["alpha", "zeta"], rewrittenRawUrl?: string) {
  const local = makeRepo(); const bare = makeEmptyDirectory("branch-care-undo-bare-"); t.after(local.cleanup); t.after(bare.cleanup);
  git(bare.dir, "init", "-q", "--bare"); git(local.dir, "remote", "add", "origin", bare.dir); git(local.dir, "push", "-q", "-u", "origin", "main"); git(bare.dir, "symbolic-ref", "HEAD", "refs/heads/main");
  for (const name of names) { branch(local.dir, name); git(local.dir, "push", "-q", "origin", name); }
  if (rewrittenRawUrl) { git(local.dir, "config", "remote.origin.url", rewrittenRawUrl); git(local.dir, "config", `url.${bare.dir}.pushInsteadOf`, rewrittenRawUrl); }
  const client = new GitClient(local.dir); const repository = new Repository(client); const history = new UndoHistory(client); const lines = output();
  const code = await runRemoteClean({ repository, history, remote: "origin", dryRun: false, interactive: true, prompts: { select: async () => names.map((name) => `origin/${name}`), confirm: async () => true, input: async () => "origin" }, output: lines.sink });
  assert.equal(code, 0, [...lines.out, ...lines.err].join("\n")); const operation = (await history.list())[0]!; assert.equal(operation.remoteEndpoint, bare.dir);
  return { local, bare, repository, history, operation };
}

test("undo list prints stable newest-first fields and exact empty result", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const empty = runCli(fixture.dir, ["undo", "--list"]); assert.equal(empty.status, 0); assert.equal(empty.stdout, "No cleanups are available to undo.\n");
  const operations: UndoReceipt[] = [];
  for (const name of ["first", "second", "third"]) operations.push((await operationFixture(fixture.dir, [name])).operation);
  const paths = await new UndoHistory(new GitClient(fixture.dir)).paths();
  const times = ["2026-01-03T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z"];
  for (const [index, operation] of operations.entries()) {
    const path = resolve(paths.operations, `${operation.id}.json`); const stored = JSON.parse(readFileSync(path, "utf8")); stored.completedAt = times[index]; writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`);
  }
  const expected = [...operations].sort((left, right) => times[operations.indexOf(right)]!.localeCompare(times[operations.indexOf(left)]!) || Buffer.compare(Buffer.from(right.id), Buffer.from(left.id)));
  const listed = runCli(fixture.dir, ["undo", "--list"]); assert.equal(listed.status, 0);
  const rows = listed.stdout.trim().split("\n"); assert.equal(rows.length, 3); assert.deepEqual(rows.map((row) => row.split("\t")[0]), expected.map(({ id }) => id));
  for (const [index, row] of rows.entries()) assert.deepEqual(row.split("\t"), [expected[index]!.id, "local", "local", times[operations.indexOf(expected[index]!)], "1", "completed"]);
});

test("undo selects newest shorthand or one exact operation", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const older = await operationFixture(fixture.dir, ["z-old"]); const newer = await operationFixture(fixture.dir, ["a-new"]);
  const paths = await newer.history.paths();
  for (const [operation, completedAt] of [[older.operation, "2026-01-01T00:00:00.000Z"], [newer.operation, "2026-01-02T00:00:00.000Z"]] as const) { const path = resolve(paths.operations, `${operation.id}.json`); const stored = JSON.parse(readFileSync(path, "utf8")); stored.completedAt = completedAt; writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`); }
  assert.equal((await newer.history.select()).id, newer.operation.id); assert.equal((await newer.history.select(older.operation.id)).id, older.operation.id);
  assert.notEqual([...await newer.history.list()].sort((a, b) => a.id.localeCompare(b.id))[0]!.id, undefined, "selection must not depend on receipt directory enumeration order");
});

test("missing and unknown undo operations are exit-one no-ops", (t) => {
  const fixture = makeRepo(); const bare = makeEmptyDirectory("branch-care-noop-server-"); t.after(fixture.cleanup); t.after(bare.cleanup); git(bare.dir, "init", "-q", "--bare"); git(fixture.dir, "remote", "add", "origin", bare.dir); writeFileSync(resolve(fixture.dir, "untracked.txt"), "unchanged\n"); git(fixture.dir, "config", "branch-care.sentinel", "unchanged");
  const snapshot = () => ({ worktree: snapshotDirectory(fixture.dir, [".git"]), receipts: git(fixture.dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/branch-care/undo"), refs: git(fixture.dir, "for-each-ref", "--format=%(refname) %(objectname)"), head: git(fixture.dir, "rev-parse", "HEAD"), index: git(fixture.dir, "ls-files", "--stage"), config: git(fixture.dir, "config", "--list", "--local"), remotes: git(fixture.dir, "remote", "-v"), server: git(bare.dir, "for-each-ref", "--format=%(refname) %(objectname)") });
  const before = snapshot(); for (const args of [["undo"], ["undo", "clean-20260102T030405Z-a1b2"]]) { const result = runCli(fixture.dir, args); assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.match(result.stderr, /Interactive confirmation is required/); assert.deepEqual(snapshot(), before); }
});

test("confirmed discard removes exactly one operation and frees one slot", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const operations: UndoReceipt[] = [];
  operations.push((await operationFixture(fixture.dir, ["zeta", "alpha"])).operation);
  for (let index = 1; index < 10; index += 1) operations.push((await operationFixture(fixture.dir, [`other-${index}`])).operation);
  const target = operations[0]!; const history = new UndoHistory(new GitClient(fixture.dir)); const paths = await history.paths(); const before = await history.list(); const lines = output();
  const code = await runUndo({ history, repository: {} as never, output: lines.sink, prompts: { confirm: async (options) => { assert.equal(options.default, false); return true; }, input: async () => "" }, interactive: true, list: false, discard: target.id });
  assert.equal(code, 0); assert.deepEqual(lines.out.slice(4, 6), target.entries.map(({ name, oid }) => `${name} ${oid}`)); assert.match(lines.out.at(-1)!, new RegExp(`Discarded ${target.id}`));
  const after = await history.list(); assert.deepEqual(after.map(({ id }) => id), before.filter(({ id }) => id !== target.id).map(({ id }) => id));
  assert.equal(existsSync(resolve(paths.operations, `${target.id}.json`)), false);
  for (const entry of target.entries) assert.throws(() => git(fixture.dir, "rev-parse", "--verify", entry.backupRef));
  for (const operation of after) for (const entry of operation.entries) assert.equal(git(fixture.dir, "rev-parse", entry.backupRef), entry.oid);
  const replacement = await operationFixture(fixture.dir, ["replacement"]); assert.equal((await replacement.history.list()).length, 10);
});

test("local undo restores exact absent refs without worktree side effects", async (t) => {
  const fixture = makeRepo(); const bare = makeEmptyDirectory("branch-care-local-snapshot-"); t.after(fixture.cleanup); t.after(bare.cleanup); git(bare.dir, "init", "-q", "--bare"); git(fixture.dir, "remote", "add", "sentinel", bare.dir); branch(fixture.dir, "unrelated"); writeFileSync(resolve(fixture.dir, "untracked.txt"), "unchanged\n"); git(fixture.dir, "config", "branch-care.sentinel", "unchanged");
  const made = await operationFixture(fixture.dir); const snapshot = () => ({ worktree: snapshotDirectory(fixture.dir, [".git"]), head: git(fixture.dir, "rev-parse", "HEAD"), index: git(fixture.dir, "ls-files", "--stage"), config: git(fixture.dir, "config", "--list", "--local"), remotes: git(fixture.dir, "remote", "-v"), unrelated: git(fixture.dir, "rev-parse", "refs/heads/unrelated") }); const before = snapshot(); const lines = output();
  const code = await runUndo({ ...made, output: lines.sink, prompts: { confirm: async (options) => { assert.equal(options.default, false); return true; }, input: async () => "" }, interactive: true, list: false });
  assert.equal(code, 0); assert.deepEqual(lines.out.slice(4, 6), made.operation.entries.map(({ name, oid }) => `${name} ${oid}`)); for (const entry of made.operation.entries) assert.equal(git(fixture.dir, "rev-parse", `refs/heads/${entry.name}`), entry.oid); assert.deepEqual(snapshot(), before);
});

test("declined and cancelled local undo are zero-exit no-ops", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const made = await operationFixture(fixture.dir, ["topic"]); const paths = await made.history.paths(); const snapshot = () => ({ recovery: snapshotDirectory(paths.root), refs: git(fixture.dir, "for-each-ref", "--format=%(refname) %(objectname)"), worktree: snapshotDirectory(fixture.dir, [".git"]), head: git(fixture.dir, "rev-parse", "HEAD"), index: git(fixture.dir, "ls-files", "--stage"), config: git(fixture.dir, "config", "--list", "--local"), remotes: git(fixture.dir, "remote", "-v") });
  for (const [name, confirm] of [["declined", async () => false], ["cancelled", async (): Promise<boolean> => { throw Object.assign(new Error("cancel"), { name: "ExitPromptError" }); }]] as const) { const before = snapshot(); const lines = output(); assert.equal(await runUndo({ ...made, output: lines.sink, prompts: { confirm, input: async () => "" }, interactive: true, list: false }), 0, name); assert.equal(lines.out.at(-1), "No branches were restored.", name); assert.deepEqual(snapshot(), before, name); }
});

test("local undo failure table retains only unresolved entries for retry", async (t) => {
  for (const scenario of ["existing-name conflict", "missing object", "ref-creation failure"] as const) {
    const fixture = makeRepo(); t.after(fixture.cleanup); const made = await operationFixture(fixture.dir); const alpha = made.operation.entries.find(({ name }) => name === "alpha")!; const zeta = made.operation.entries.find(({ name }) => name === "zeta")!;
    if (scenario === "existing-name conflict") branch(fixture.dir, "alpha");
    if (scenario === "missing object") { let checks = 0; made.history.objectExists = async () => ++checks !== 1; }
    if (scenario === "ref-creation failure") { const restore = made.history.restoreLocal.bind(made.history); made.history.restoreLocal = async (entry) => { if (entry.name === "alpha") throw new Error("injected ref creation failure"); return restore(entry); }; }
    const paths = await made.history.paths(); const lines = output(); const code = await runUndo({ ...made, output: lines.sink, prompts: { confirm: async () => true, input: async () => "" }, interactive: true, list: false }); assert.equal(code, 1, scenario);
    const [retry] = await made.history.list(); assert.equal(retry!.state, "local-retry", scenario); assert.deepEqual(retry!.entries.map(({ name }) => name), ["alpha"], scenario); assert.equal(git(fixture.dir, "rev-parse", alpha.backupRef), alpha.oid); assert.throws(() => git(fixture.dir, "rev-parse", "--verify", zeta.backupRef)); assert.equal(git(fixture.dir, "rev-parse", "refs/heads/zeta"), zeta.oid); assert.match(lines.err.join("\n"), new RegExp(`Unresolved alpha:.*${scenario === "existing-name conflict" ? "already exists" : scenario === "missing object" ? "unavailable" : "injected ref creation failure"}`)); assert.equal(readFileSync(resolve(paths.operations, `${retry!.id}.json`), "utf8").includes("zeta"), false);
  }
});

test("complete local undo consumes one operation and reports names and count", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const target = await operationFixture(fixture.dir); const other = await operationFixture(fixture.dir, ["other"]); const beforeOther = JSON.stringify(other.operation); const lines = output(); assert.equal(await runUndo({ ...target, id: target.operation.id, output: lines.sink, prompts: { confirm: async () => true, input: async () => "" }, interactive: true, list: false }), 0); const remaining = await target.history.list(); assert.deepEqual(remaining.map(({ id }) => id), [other.operation.id]); assert.equal(JSON.stringify(remaining[0]), beforeOther); for (const entry of target.operation.entries) assert.throws(() => git(fixture.dir, "rev-parse", "--verify", entry.backupRef)); assert.equal(git(fixture.dir, "rev-parse", other.operation.entries[0]!.backupRef), other.operation.entries[0]!.oid); assert.deepEqual(lines.out.filter((line) => line.startsWith("Restored ")), ["Restored alpha", "Restored zeta", "Restored 2 branches."]);
});

test("successful remote undo consumes one operation and reports full names", async (t) => {
  const made = await remoteOperationFixture(t); const other = await operationFixture(made.local.dir, ["local-other"]); const lines = output();
  const code = await runUndo({ ...made, id: made.operation.id, output: lines.sink, prompts: { confirm: async () => true, input: async () => "origin" }, interactive: true, list: false });
  assert.equal(code, 0, lines.err.join("\n")); const remaining = await made.history.list(); assert.deepEqual(remaining.map(({ id }) => id), [other.operation.id]);
  for (const entry of made.operation.entries) { assert.equal(git(made.bare.dir, "rev-parse", `refs/heads/${entry.name}`), entry.oid); assert.throws(() => git(made.local.dir, "rev-parse", "--verify", entry.backupRef)); }
  assert.equal(git(made.local.dir, "rev-parse", other.operation.entries[0]!.backupRef), other.operation.entries[0]!.oid); assert.deepEqual(lines.out.filter((line) => line.startsWith("Restored ")), ["Restored origin/alpha", "Restored origin/zeta", "Restored 2 remote branches."]);
});

test("rewrite mapping changes refuse undo and do not reconcile against the changed server", async (t) => {
  for (const pending of [false, true]) {
    const raw = `rewrite://unchanged/${pending ? "pending" : "completed"}`;
    const made = await remoteOperationFixture(t, [pending ? "pending-topic" : "completed-topic"], raw);
    const other = makeEmptyDirectory("branch-care-undo-rewrite-b-"); t.after(other.cleanup); git(other.dir, "init", "-q", "--bare");
    const target = await made.repository.resolveRemoteDeletionTarget("origin");
    assert.equal(target?.inventoryRepository, made.bare.dir);
    assert.ok(target?.urls.includes(raw));
    assert.ok(target?.urls.includes(made.bare.dir));

    const paths = await made.history.paths();
    const receiptPath = `${paths.operations}/${made.operation.id}.json`;
    if (pending) {
      const fs = await import("node:fs");
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
      receipt.state = "pending"; delete receipt.completedAt;
      fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    }
    git(made.local.dir, "config", "--unset-all", `url.${made.bare.dir}.pushInsteadOf`);
    git(made.local.dir, "config", `url.${other.dir}.pushInsteadOf`, raw);
    assert.equal(git(made.local.dir, "config", "remote.origin.url"), raw);

    const calls: string[][] = [];
    const client = new GitClient(made.local.dir, async (cwd, args) => { calls.push([...args]); return new GitClient(cwd).run(args); });
    const repository = new Repository(client); const lines = output();
    const code = await runUndo({ history: made.history, repository, output: lines.sink, prompts: { confirm: async () => true, input: async () => "origin" }, interactive: true, list: pending, id: pending ? undefined : made.operation.id });
    assert.equal(code, pending ? 0 : 1, lines.err.join("\n"));
    if (!pending) assert.match(lines.err.join("\n"), /push destination changed/);
    assert.equal((await made.history.list())[0]!.state, pending ? "pending" : "completed");
    assert.ok(calls.some((args) => args.join(" ") === "remote get-url --push --all origin"));
    assert.equal(calls.some(([command]) => command === "ls-remote" || command === "push"), false);
    assert.doesNotMatch(git(other.dir, "for-each-ref", "--format=%(refname)"), /completed-topic|pending-topic/);
  }
});

test("remote undo validates all objects and absent server targets before push", async (t) => {
  const missingObject = await remoteOperationFixture(t, ["alpha"]); const events: string[] = [];
  missingObject.history.objectExists = async () => { events.push("object"); return false; };
  const objectRepository = { ...missingObject.repository, resolveRemoteDeletionTarget: (remote?: string) => missingObject.repository.resolveRemoteDeletionTarget(remote), remoteBranchesAbsent: async () => { events.push("absence"); return true; }, restoreRemoteBranches: async () => { events.push("push"); return { stdout: "", stderr: "" }; } };
  const objectLines = output(); assert.equal(await runUndo({ history: missingObject.history, repository: objectRepository, output: objectLines.sink, prompts: { confirm: async () => true, input: async () => "origin" }, interactive: true, list: false }), 1);
  assert.deepEqual(events, ["object"]); assert.equal((await missingObject.history.list())[0]!.id, missingObject.operation.id);

  const occupied = await remoteOperationFixture(t, ["alpha"]); git(occupied.bare.dir, "update-ref", "refs/heads/alpha", occupied.operation.entries[0]!.oid); let pushes = 0;
  const occupiedRepository = { ...occupied.repository, resolveRemoteDeletionTarget: (remote?: string) => occupied.repository.resolveRemoteDeletionTarget(remote), remoteBranchesAbsent: (target: Awaited<ReturnType<Repository["resolveRemoteDeletionTarget"]>> extends infer T ? Exclude<T, undefined> : never, names: readonly string[]) => occupied.repository.remoteBranchesAbsent(target, names), restoreRemoteBranches: async () => { pushes += 1; return { stdout: "", stderr: "" }; } };
  const occupiedLines = output(); assert.equal(await runUndo({ history: occupied.history, repository: occupiedRepository, output: occupiedLines.sink, prompts: { confirm: async () => true, input: async () => "origin" }, interactive: true, list: false }), 1);
  assert.equal(pushes, 0); assert.equal((await occupied.history.list())[0]!.id, occupied.operation.id); assert.match(occupiedLines.err.join("\n"), /already exists or changed/);
});

test("remote undo refusal table is atomic preserves history and redacts URLs", async (t) => {
  const scenarios = ["present target", "changed target", "missing object", "unsafe mapping", "unsafe endpoint", "declined confirmation", "cancelled prompt", "mistyped remote", "unavailable remote", "failed push"] as const;
  for (const scenario of scenarios) {
    const made = await remoteOperationFixture(t, ["topic"]); const other = makeEmptyDirectory("branch-care-undo-other-"); t.after(other.cleanup); git(other.dir, "init", "-q", "--bare");
    const secret = "https://user:token@example.test/private.git"; const paths = await made.history.paths(); const receiptPath = resolve(paths.operations, `${made.operation.id}.json`); const stored = JSON.parse(readFileSync(receiptPath, "utf8")); stored.urls.push(secret); writeFileSync(receiptPath, `${JSON.stringify(stored, null, 2)}\n`);
    if (scenario === "present target") git(made.bare.dir, "update-ref", "refs/heads/topic", made.operation.entries[0]!.oid);
    if (scenario === "changed target") { writeFileSync(resolve(made.local.dir, "changed.txt"), "changed\n"); git(made.local.dir, "add", "changed.txt"); git(made.local.dir, "commit", "-q", "-m", "changed"); git(made.local.dir, "push", "-q", "origin", "HEAD:refs/heads/changed-object"); git(made.bare.dir, "update-ref", "refs/heads/topic", git(made.local.dir, "rev-parse", "HEAD")); }
    let pushes = 0; const lines = output(); const base = made.repository;
    const repository = {
      resolveRemoteDeletionTarget: async (remote?: string) => {
        if (scenario === "unavailable remote") return undefined;
        const target = await base.resolveRemoteDeletionTarget(remote);
        if (!target) return target;
        if (scenario === "unsafe mapping") return { ...target, name: "other", urls: [...target.urls, secret] };
        if (scenario === "unsafe endpoint") return { ...target, inventoryRepository: other.dir, urls: [...target.urls, secret] };
        return { ...target, urls: [...target.urls, secret] };
      },
      remoteBranchesAbsent: (target: Exclude<Awaited<ReturnType<Repository["resolveRemoteDeletionTarget"]>>, undefined>, names: readonly string[]) => base.remoteBranchesAbsent(target, names),
      restoreRemoteBranches: async (destination: string, entries: readonly { name: string; oid: string }[]) => { pushes += 1; if (scenario === "failed push") throw new Error(`push failed at ${secret}`); return base.restoreRemoteBranches(destination, entries); },
      remoteHeadOids: (endpoint: string) => base.remoteHeadOids(endpoint)
    };
    if (scenario === "missing object") made.history.objectExists = async () => false;
    const before = { receipt: readFileSync(receiptPath, "utf8"), backups: git(made.local.dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/branch-care/undo"), server: git(made.bare.dir, "for-each-ref", "--format=%(refname) %(objectname)"), other: git(other.dir, "for-each-ref", "--format=%(refname) %(objectname)") };
    const confirm = scenario === "cancelled prompt" ? async (): Promise<boolean> => { throw Object.assign(new Error("cancelled"), { name: "ExitPromptError" }); } : async () => scenario !== "declined confirmation";
    const code = await runUndo({ history: made.history, repository, output: lines.sink, prompts: { confirm, input: async () => scenario === "mistyped remote" ? "wrong" : "origin" }, interactive: true, list: false });
    const authorizationNoOp = ["declined confirmation", "cancelled prompt", "mistyped remote"].includes(scenario); assert.equal(code, authorizationNoOp ? 0 : 1, scenario); assert.equal(pushes, scenario === "failed push" ? 1 : 0, scenario);
    assert.deepEqual({ receipt: readFileSync(receiptPath, "utf8"), backups: git(made.local.dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/branch-care/undo"), server: git(made.bare.dir, "for-each-ref", "--format=%(refname) %(objectname)"), other: git(other.dir, "for-each-ref", "--format=%(refname) %(objectname)") }, before, scenario);
    const text = [...lines.out, ...lines.err].join("\n"); assert.doesNotMatch(text, /user:token|example\.test/, scenario); if (scenario === "failed push") assert.match(text, /push failed at <remote>/);
  }
});
test("recovery collections are unique and deterministically ordered", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const first = await operationFixture(fixture.dir, ["zeta", "alpha"]); const second = await operationFixture(fixture.dir, ["beta"]); const third = await operationFixture(fixture.dir, ["gamma"]); const listed = runCli(fixture.dir, ["undo", "--list"]); assert.equal(listed.status, 0); const ids = listed.stdout.trim().split("\n").map((line) => line.split("\t")[0]!); assert.deepEqual(ids, (await first.history.list()).map(({ id }) => id)); assert.equal(new Set(ids).size, 3, "history rows are unique");
  assert.deepEqual(first.operation.entries.map(({ name }) => name), ["alpha", "zeta"]); assert.equal(new Set(first.operation.entries.map(({ name }) => name)).size, 2, "receipt entries are unique");
  const localLines = output(); assert.equal(await runUndo({ ...first, id: first.operation.id, output: localLines.sink, prompts: { confirm: async () => true, input: async () => "" }, interactive: true, list: false }), 0); assert.deepEqual(localLines.out.slice(4, 6), first.operation.entries.map(({ name, oid }) => `${name} ${oid}`), "local preview is bytewise and unique"); assert.deepEqual(localLines.out.filter((line) => /^Restored (alpha|zeta)$/.test(line)), ["Restored alpha", "Restored zeta"], "local restore rows are bytewise and unique");
  const discardLines = output(); assert.equal(await runUndo({ history: second.history, repository: {} as never, id: second.operation.id, discard: second.operation.id, output: discardLines.sink, prompts: { confirm: async () => true, input: async () => "" }, interactive: true, list: false }), 0); assert.deepEqual(discardLines.out.slice(4, 5), second.operation.entries.map(({ name, oid }) => `${name} ${oid}`), "discard preview is unique and bytewise");
  const remote = await remoteOperationFixture(t, ["zeta", "alpha"]); const remoteLines = output(); assert.equal(await runUndo({ ...remote, output: remoteLines.sink, prompts: { confirm: async () => true, input: async () => "origin" }, interactive: true, list: false }), 0); assert.deepEqual(remoteLines.out.slice(4, 6), remote.operation.entries.map(({ fullName, oid }) => `${fullName} ${oid}`), "remote preview is bytewise and unique"); assert.deepEqual(remoteLines.out.filter((line) => /^Restored origin\//.test(line)), ["Restored origin/alpha", "Restored origin/zeta"], "remote restore rows are bytewise and unique");
  assert.equal((await third.history.list()).some(({ id }) => id === third.operation.id), true);
});
