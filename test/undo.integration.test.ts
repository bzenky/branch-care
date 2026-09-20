import assert from "node:assert/strict";
import test from "node:test";
import { runClean } from "../src/commands/clean.js";
import { runRemoteClean } from "../src/commands/remote-clean.js";
import { runUndo } from "../src/commands/undo.js";
import { GitClient } from "../src/git/client.js";
import { Repository } from "../src/git/repository.js";
import { UndoHistory } from "../src/undo-history.js";
import { branch, git, makeEmptyDirectory, makeRepo, refs, runCli } from "./helpers.js";

async function operationFixture(dir: string, names = ["zeta", "alpha"]) {
  for (const name of names) branch(dir, name); const gitClient = new GitClient(dir); const repository = new Repository(gitClient); const history = new UndoHistory(gitClient); const output: string[] = [];
  const code = await runClean({ repository, history, dryRun: false, interactive: true, prompts: { select: async () => names, confirm: async () => true }, output: { out: (line) => output.push(line), err: (line) => output.push(`ERR:${line}`) } }); assert.equal(code, 0, output.join("\n"));
  return { repository, history, operation: (await history.list())[0]!, output };
}
function output() { const out: string[] = []; const err: string[] = []; return { out, err, sink: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } }; }

async function remoteOperationFixture(t: test.TestContext, names = ["alpha", "zeta"]) {
  const local = makeRepo(); const bare = makeEmptyDirectory("branch-care-undo-bare-"); t.after(local.cleanup); t.after(bare.cleanup);
  git(bare.dir, "init", "-q", "--bare"); git(local.dir, "remote", "add", "origin", bare.dir); git(local.dir, "push", "-q", "-u", "origin", "main"); git(bare.dir, "symbolic-ref", "HEAD", "refs/heads/main");
  for (const name of names) { branch(local.dir, name); git(local.dir, "push", "-q", "origin", name); }
  const client = new GitClient(local.dir); const repository = new Repository(client); const history = new UndoHistory(client); const lines = output();
  const code = await runRemoteClean({ repository, history, remote: "origin", dryRun: false, interactive: true, prompts: { select: async () => names.map((name) => `origin/${name}`), confirm: async () => true, input: async () => "origin" }, output: lines.sink });
  assert.equal(code, 0, [...lines.out, ...lines.err].join("\n")); const operation = (await history.list())[0]!; assert.equal(operation.remoteEndpoint, bare.dir);
  return { local, bare, repository, history, operation };
}

test("undo list prints stable newest-first fields and exact empty result", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const empty = runCli(fixture.dir, ["undo", "--list"]); assert.equal(empty.status, 0); assert.equal(empty.stdout, "No cleanups are available to undo.\n");
  const made = await operationFixture(fixture.dir, ["topic"]); const listed = runCli(fixture.dir, ["undo", "--list"]); assert.equal(listed.status, 0); for (const value of [made.operation.id, "local", "1", "completed"]) assert.ok(listed.stdout.includes(value));
});

test("undo selects newest shorthand or one exact operation", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const made = await operationFixture(fixture.dir, ["topic"]); assert.equal((await made.history.select()).id, made.operation.id); assert.equal((await made.history.select(made.operation.id)).id, made.operation.id);
});

test("missing and unknown undo operations are exit-one no-ops", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const before = refs(fixture.dir); for (const args of [["undo"], ["undo", "clean-20260102T030405Z-a1b2"]]) { const result = runCli(fixture.dir, args); assert.equal(result.status, 1); assert.match(result.stderr, /No cleanup/); } assert.equal(refs(fixture.dir), before);
});

test("confirmed discard removes exactly one operation and frees one slot", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const made = await operationFixture(fixture.dir, ["topic"]); const lines = output(); const code = await runUndo({ ...made, output: lines.sink, prompts: { confirm: async (options) => { assert.equal(options.default, false); return true; }, input: async () => "" }, interactive: true, list: false, discard: made.operation.id }); assert.equal(code, 0); assert.deepEqual(await made.history.list(), []); assert.match(lines.out.join("\n"), /Discarded/);
});

test("local undo restores exact absent refs without worktree side effects", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const head = git(fixture.dir, "rev-parse", "HEAD"); const made = await operationFixture(fixture.dir); const lines = output(); const code = await runUndo({ ...made, output: lines.sink, prompts: { confirm: async (options) => { assert.equal(options.default, false); return true; }, input: async () => "" }, interactive: true, list: false }); assert.equal(code, 0); for (const entry of made.operation.entries) assert.equal(git(fixture.dir, "rev-parse", `refs/heads/${entry.name}`), entry.oid); assert.equal(git(fixture.dir, "rev-parse", "HEAD"), head);
});

test("declined and cancelled local undo are zero-exit no-ops", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const made = await operationFixture(fixture.dir, ["topic"]); for (const confirm of [async () => false, async (): Promise<boolean> => { throw Object.assign(new Error("cancel"), { name: "ExitPromptError" }); }]) { const lines = output(); assert.equal(await runUndo({ ...made, output: lines.sink, prompts: { confirm, input: async () => "" }, interactive: true, list: false }), 0); assert.equal((await made.history.list()).length, 1); }
});

test("local undo failure table retains only unresolved entries for retry", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const made = await operationFixture(fixture.dir); branch(fixture.dir, "alpha"); const lines = output(); const code = await runUndo({ ...made, output: lines.sink, prompts: { confirm: async () => true, input: async () => "" }, interactive: true, list: false }); assert.equal(code, 1); const [retry] = await made.history.list(); assert.deepEqual(retry!.entries.map(({ name }) => name), ["alpha"]); assert.equal(git(fixture.dir, "rev-parse", "refs/heads/zeta"), made.operation.entries.find(({ name }) => name === "zeta")!.oid);
});

test("complete local undo consumes one operation and reports names and count", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const made = await operationFixture(fixture.dir); const lines = output(); assert.equal(await runUndo({ ...made, output: lines.sink, prompts: { confirm: async () => true, input: async () => "" }, interactive: true, list: false }), 0); assert.deepEqual(await made.history.list(), []); assert.match(lines.out.join("\n"), /Restored alpha[\s\S]*Restored zeta[\s\S]*Restored 2 branches/);
});

test("successful remote undo consumes one operation and reports full names", async (t) => {
  const made = await remoteOperationFixture(t); const lines = output();
  const code = await runUndo({ ...made, output: lines.sink, prompts: { confirm: async () => true, input: async () => "origin" }, interactive: true, list: false });
  assert.equal(code, 0, lines.err.join("\n")); assert.deepEqual(await made.history.list(), []);
  for (const entry of made.operation.entries) assert.equal(git(made.bare.dir, "rev-parse", `refs/heads/${entry.name}`), entry.oid);
  assert.match(lines.out.join("\n"), /Restored origin\/alpha[\s\S]*Restored origin\/zeta[\s\S]*Restored 2 remote branches/);
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
  const cases = ["changed endpoint", "inventory failure"] as const;
  for (const scenario of cases) {
    const made = await remoteOperationFixture(t, ["topic"]); const other = makeEmptyDirectory("branch-care-undo-other-"); t.after(other.cleanup); git(other.dir, "init", "-q", "--bare");
    const secret = "https://user:token@example.test/private.git"; let pushes = 0; const lines = output();
    if (scenario === "changed endpoint") git(made.local.dir, "config", "remote.origin.url", other.dir);
    const repository = scenario === "changed endpoint" ? made.repository : {
      resolveRemoteDeletionTarget: (remote?: string) => made.repository.resolveRemoteDeletionTarget(remote),
      remoteBranchesAbsent: async () => { throw new Error(`inventory failed at ${secret}`); },
      restoreRemoteBranches: async () => { pushes += 1; return { stdout: "", stderr: "" }; },
      remoteHeadOids: (endpoint: string) => made.repository.remoteHeadOids(endpoint)
    };
    if (scenario === "inventory failure") {
      const path = await made.history.paths(); const receiptPath = `${path.operations}/${made.operation.id}.json`; const receipt = JSON.parse((await import("node:fs")).readFileSync(receiptPath, "utf8")); receipt.urls.push(secret); (await import("node:fs")).writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    }
    const beforeA = git(made.bare.dir, "for-each-ref", "--format=%(refname) %(objectname)"); const beforeB = git(other.dir, "for-each-ref", "--format=%(refname) %(objectname)");
    const code = await runUndo({ history: made.history, repository, output: lines.sink, prompts: { confirm: async () => true, input: async () => "origin" }, interactive: true, list: false });
    assert.equal(code, 1, scenario); assert.equal(pushes, 0); assert.equal((await made.history.list())[0]!.id, made.operation.id); assert.equal(git(made.bare.dir, "for-each-ref", "--format=%(refname) %(objectname)"), beforeA); assert.equal(git(other.dir, "for-each-ref", "--format=%(refname) %(objectname)"), beforeB);
    if (scenario === "changed endpoint") assert.match(lines.err.join("\n"), /push destination changed/); else { assert.match(lines.err.join("\n"), /<remote>/); assert.doesNotMatch(lines.err.join("\n"), /user:token|example\.test/); }
  }
});
test("recovery collections are unique and deterministically ordered", async (t) => { const fixture = makeRepo(); t.after(fixture.cleanup); const made = await operationFixture(fixture.dir); assert.deepEqual(made.operation.entries.map(({ name }) => name), ["alpha", "zeta"]); assert.equal(new Set(made.operation.entries.map(({ name }) => name)).size, 2); });
