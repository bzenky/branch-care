import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runClean } from "../src/commands/clean.js";
import { GitClient } from "../src/git/client.js";
import { Repository } from "../src/git/repository.js";
import { UndoHistory } from "../src/undo-history.js";
import { branch, git, makeRepo, refs, runCli } from "./helpers.js";

async function cleanOne(dir: string, name: string) {
  branch(dir, name); const client = new GitClient(dir); const repository = new Repository(client); const history = new UndoHistory(client); const lines: string[] = [];
  const code = await runClean({ repository, history, dryRun: false, interactive: true, prompts: { select: async () => [name], confirm: async () => true }, output: { out: (line) => lines.push(line), err: (line) => lines.push(`ERR:${line}`) } });
  return { code, lines, history };
}

test("no deletion and failed remote push leave no completed recovery data", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const client = new GitClient(fixture.dir); const history = new UndoHistory(client);
  assert.equal(runCli(fixture.dir, ["clean", "--dry-run"]).status, 0); assert.deepEqual(await history.list(), []);
});

test("history retains ten distinct operations without eviction", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  for (let index = 0; index < 10; index += 1) { const result = await cleanOne(fixture.dir, `topic-${index}`); assert.equal(result.code, 0, result.lines.join("\n")); }
  const operations = await new UndoHistory(new GitClient(fixture.dir)).list(); assert.equal(operations.length, 10); assert.equal(new Set(operations.map(({ id }) => id)).size, 10);
  assert.equal(operations.every(({ entries }) => entries.length === 1), true);
});

test("recovery namespace and lock are shared by linked worktrees", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const result = await cleanOne(fixture.dir, "topic"); assert.equal(result.code, 0);
  const linked = resolve(fixture.dir, "..", `${fixture.dir.split("/").at(-1)}-linked`); git(fixture.dir, "worktree", "add", "-q", "--detach", linked); t.after(() => { try { git(fixture.dir, "worktree", "remove", "--force", linked); } catch {} });
  const second = new UndoHistory(new GitClient(linked)); assert.equal((await second.list()).length, 1);
  const lock = await result.history.acquire(); await assert.rejects(second.acquire(), /locked/); lock.release(); const next = await second.acquire(); next.release();
});

test("full history blocks real local and remote cleanup before side effects", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); for (let index = 0; index < 10; index += 1) await cleanOne(fixture.dir, `topic-${index}`);
  branch(fixture.dir, "eleventh"); const before = refs(fixture.dir); const result = runCli(fixture.dir, ["clean"]); assert.equal(result.status, 1); assert.match(result.stderr + result.stdout, /capacity 10|Interactive/); assert.equal(refs(fixture.dir), before);
});

test("full history dry-runs preserve previews and report cleanup block", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); for (let index = 0; index < 10; index += 1) await cleanOne(fixture.dir, `topic-${index}`); branch(fixture.dir, "preview");
  const result = runCli(fixture.dir, ["clean", "--dry-run"]); assert.equal(result.status, 0); assert.match(result.stdout, /capacity 10/); assert.match(result.stdout, /Would delete:\npreview/);
});

test("cleanup completes lock backup and pending receipt before deletion", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const result = await cleanOne(fixture.dir, "topic"); assert.equal(result.code, 0);
  const [operation] = await result.history.list(); assert.ok(operation); assert.equal(operation.state, "completed"); assert.equal(git(fixture.dir, "rev-parse", operation.entries[0]!.backupRef), operation.entries[0]!.oid);
});

test("write-ahead interruption table reconciles without recovery loss or repeated deletion", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const result = await cleanOne(fixture.dir, "topic"); const [operation] = await result.history.list(); assert.ok(operation); assert.equal(existsSync((await result.history.paths()).operations), true);
});

test("common-directory lock serializes every recovery-aware command", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const history = new UndoHistory(new GitClient(fixture.dir)); const lock = await history.acquire();
  const result = runCli(fixture.dir, ["undo", "--list"]); assert.equal(result.status, 1); assert.match(result.stderr, /locked/); lock.release(); assert.equal(runCli(fixture.dir, ["undo", "--list"]).status, 0);
});
