import assert from "node:assert/strict";
import test from "node:test";
import { runUndo } from "../src/commands/undo.js";

test("discard no-op and failure table preserves recoverability", async () => {
  let removed = 0; const operation = { version: 1 as const, id: "clean-20260102T030405Z-a1b2", state: "completed" as const, kind: "local" as const, createdAt: "2026-01-02T03:04:05.000Z", completedAt: "2026-01-02T03:04:06.000Z", entries: [{ name: "topic", fullName: "topic", oid: "a".repeat(40), backupRef: "refs/branch-care/undo/clean-20260102T030405Z-a1b2/local/topic", restoration: "remaining" as const }] };
  const history = { acquire: async () => ({ release() {} }), reconcilePending: async () => [operation], select: async () => operation, remove: async () => { removed += 1; } } as never;
  const repository = {} as never; const lines: string[] = [];
  const code = await runUndo({ history, repository, output: { out: (line) => lines.push(line), err: (line) => lines.push(line) }, prompts: { confirm: async (options) => { assert.equal(options.default, false); return false; }, input: async () => "" }, interactive: true, list: false, discard: operation.id });
  assert.equal(code, 0); assert.equal(removed, 0); assert.match(lines.join("\n"), /not discarded/);
});

test("remote undo pins the verified endpoint and retains original redaction URLs", async () => {
  const secret = "https://user:token@example.test/private.git"; const operation = { version: 1 as const, id: "clean-20260102T030405Z-a1b2", state: "completed" as const, kind: "remote" as const, remote: "origin", remoteEndpoint: "/verified.git", urls: [secret], createdAt: "2026-01-02T03:04:05.000Z", completedAt: "2026-01-02T03:04:06.000Z", entries: [{ name: "topic", fullName: "origin/topic", oid: "a".repeat(40), backupRef: "refs/branch-care/undo/clean-20260102T030405Z-a1b2/remote/topic", restoration: "remaining" as const }] };
  const history = { acquire: async () => ({ release() {} }), reconcilePending: async () => [operation], select: async () => operation, objectExists: async () => true } as never; const errors: string[] = []; let pushes = 0;
  const changed = await runUndo({ history, repository: { resolveRemoteDeletionTarget: async () => ({ name: "origin", urls: [secret], inventoryRepository: "/changed.git" }), remoteBranchesAbsent: async () => true, restoreRemoteBranches: async () => { pushes += 1; return { stdout: "", stderr: "" }; } }, output: { out() {}, err: (line) => errors.push(line) }, prompts: { confirm: async () => true, input: async () => "origin" }, interactive: true, list: false });
  assert.equal(changed, 1); assert.equal(pushes, 0); assert.match(errors.join("\n"), /push destination changed/);
  errors.length = 0; const failedResolve = await runUndo({ history, repository: { resolveRemoteDeletionTarget: async () => { throw new Error(`failed at ${secret}`); }, remoteBranchesAbsent: async () => true, restoreRemoteBranches: async () => ({ stdout: "", stderr: "" }) }, output: { out() {}, err: (line) => errors.push(line) }, prompts: { confirm: async () => true, input: async () => "origin" }, interactive: true, list: false });
  assert.equal(failedResolve, 1); assert.match(errors.join("\n"), /<remote>/); assert.doesNotMatch(errors.join("\n"), /user:token|example\.test/);
});

test("remote undo previews in order and re-resolves after two confirmations", async () => {
  const calls: string[] = []; const operation = { version: 1 as const, id: "clean-20260102T030405Z-a1b2", state: "completed" as const, kind: "remote" as const, remote: "origin", remoteEndpoint: "origin", urls: [], createdAt: "2026-01-02T03:04:05.000Z", completedAt: "2026-01-02T03:04:06.000Z", entries: ["zeta", "alpha"].map((name) => ({ name, fullName: `origin/${name}`, oid: "a".repeat(40), backupRef: `refs/branch-care/undo/clean-20260102T030405Z-a1b2/remote/${name}`, restoration: "remaining" as const })) };
  const history = { acquire: async () => ({ release() {} }), reconcilePending: async () => [operation], select: async () => operation, objectExists: async () => true, beginRestore: async () => operation, remove: async () => { calls.push("remove"); } } as never;
  const repository = { resolveRemoteDeletionTarget: async () => { calls.push("resolve"); return { name: "origin", urls: [], inventoryRepository: "origin" }; }, remoteBranchesAbsent: async () => true, restoreRemoteBranches: async () => { calls.push("push"); return { stdout: "", stderr: "" }; } };
  const lines: string[] = []; let prompts = 0; const code = await runUndo({ history, repository, output: { out: (line) => lines.push(line), err: (line) => lines.push(line) }, prompts: { confirm: async (options) => { prompts += 1; assert.equal(options.default, false); return true; }, input: async () => { prompts += 1; return "origin"; } }, interactive: true, list: false });
  assert.equal(code, 0); assert.equal(prompts, 2); assert.deepEqual(calls, ["resolve", "push", "remove"]); assert.ok(lines.indexOf(`${operation.entries[1]!.fullName} ${operation.entries[1]!.oid}`) < lines.indexOf(`${operation.entries[0]!.fullName} ${operation.entries[0]!.oid}`));
});
