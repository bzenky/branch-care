import assert from "node:assert/strict";
import test from "node:test";
import { runUndo } from "../src/commands/undo.js";

test("discard no-op and failure table preserves recoverability", async () => {
  let removed = 0; const operation = { version: 1 as const, id: "clean-20260102T030405Z-a1b2", state: "completed" as const, kind: "local" as const, createdAt: "2026-01-02T03:04:05.000Z", completedAt: "2026-01-02T03:04:06.000Z", entries: [{ name: "topic", fullName: "topic", oid: "a".repeat(40), backupRef: "refs/branch-care/undo/clean-20260102T030405Z-a1b2/local/topic", restoration: "remaining" as const }] };
  const history = { acquire: async () => ({ release() {} }), list: async () => [operation], select: async () => operation, remove: async () => { removed += 1; } } as never;
  const repository = {} as never; const lines: string[] = [];
  const code = await runUndo({ history, repository, output: { out: (line) => lines.push(line), err: (line) => lines.push(line) }, prompts: { confirm: async (options) => { assert.equal(options.default, false); return false; }, input: async () => "" }, interactive: true, list: false, discard: operation.id });
  assert.equal(code, 0); assert.equal(removed, 0); assert.match(lines.join("\n"), /not discarded/);
});

test("remote undo previews in order and re-resolves after two confirmations", async () => {
  const calls: string[] = []; const operation = { version: 1 as const, id: "clean-20260102T030405Z-a1b2", state: "completed" as const, kind: "remote" as const, remote: "origin", createdAt: "2026-01-02T03:04:05.000Z", completedAt: "2026-01-02T03:04:06.000Z", entries: ["zeta", "alpha"].map((name) => ({ name, fullName: `origin/${name}`, oid: "a".repeat(40), backupRef: `refs/branch-care/undo/clean-20260102T030405Z-a1b2/remote/${name}`, restoration: "remaining" as const })) };
  const history = { acquire: async () => ({ release() {} }), list: async () => [operation], select: async () => operation, objectExists: async () => true, remove: async () => { calls.push("remove"); } } as never;
  const repository = { resolveRemoteDeletionTarget: async () => { calls.push("resolve"); return { name: "origin", urls: [], inventoryRepository: "origin" }; }, remoteBranchesAbsent: async () => true, restoreRemoteBranches: async () => { calls.push("push"); return { stdout: "", stderr: "" }; } };
  const lines: string[] = []; let prompts = 0; const code = await runUndo({ history, repository, output: { out: (line) => lines.push(line), err: (line) => lines.push(line) }, prompts: { confirm: async (options) => { prompts += 1; assert.equal(options.default, false); return true; }, input: async () => { prompts += 1; return "origin"; } }, interactive: true, list: false });
  assert.equal(code, 0); assert.equal(prompts, 2); assert.deepEqual(calls, ["resolve", "push", "remove"]); assert.ok(lines.indexOf(`${operation.entries[1]!.fullName} ${operation.entries[1]!.oid}`) < lines.indexOf(`${operation.entries[0]!.fullName} ${operation.entries[0]!.oid}`));
});
