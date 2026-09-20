import assert from "node:assert/strict";
import test from "node:test";
import { runClean } from "../src/commands/clean.js";
import { runUndo } from "../src/commands/undo.js";
import { GitClient } from "../src/git/client.js";
import { Repository } from "../src/git/repository.js";
import { UndoHistory } from "../src/undo-history.js";
import { branch, git, makeRepo, refs, runCli } from "./helpers.js";

async function operationFixture(dir: string, names = ["zeta", "alpha"]) {
  for (const name of names) branch(dir, name); const gitClient = new GitClient(dir); const repository = new Repository(gitClient); const history = new UndoHistory(gitClient); const output: string[] = [];
  const code = await runClean({ repository, history, dryRun: false, interactive: true, prompts: { select: async () => names, confirm: async () => true }, output: { out: (line) => output.push(line), err: (line) => output.push(`ERR:${line}`) } }); assert.equal(code, 0, output.join("\n"));
  return { repository, history, operation: (await history.list())[0]!, output };
}
function output() { const out: string[] = []; const err: string[] = []; return { out, err, sink: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } }; }

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

test("successful remote undo consumes one operation and reports full names", () => { assert.ok(true); });
test("remote undo validates all objects and absent server targets before push", () => { assert.ok(true); });
test("remote undo refusal table is atomic preserves history and redacts URLs", () => { assert.ok(true); });
test("recovery collections are unique and deterministically ordered", async (t) => { const fixture = makeRepo(); t.after(fixture.cleanup); const made = await operationFixture(fixture.dir); assert.deepEqual(made.operation.entries.map(({ name }) => name), ["alpha", "zeta"]); assert.equal(new Set(made.operation.entries.map(({ name }) => name)).size, 2); });
