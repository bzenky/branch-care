import { runClean } from "../dist/src/commands/clean.js";
import { runPrune } from "../dist/src/commands/prune.js";
import { runRemoteClean } from "../dist/src/commands/remote-clean.js";
import { runUndo } from "../dist/src/commands/undo.js";
import { runMenu } from "../dist/src/index.js";

const scenario = process.argv[2];
const stdout = []; const stderr = []; const output = { out: (line) => stdout.push(line), err: (line) => stderr.push(line) };
const branch = { name: "topic", commitTimestamp: new Date(0), ageDays: 100, author: "A", upstream: undefined, isCurrent: false, isMerged: true, isStale: true, isProtected: false, isCandidate: true };
const remoteBranch = { fullName: "origin/topic", branchName: "topic", oid: "a".repeat(40), ageDays: 100 };
const operation = { version: 1, id: "clean-20260102T030405Z-a1", state: "completed", kind: "local", createdAt: "2026-01-02T03:04:05.000Z", completedAt: "2026-01-02T03:04:06.000Z", entries: [{ name: "topic", fullName: "topic", oid: "a".repeat(40), backupRef: "refs/branch-care/undo/clean-20260102T030405Z-a1/local/topic", restoration: "remaining" }] };
const lock = { release() {} };
let code;
switch (scenario) {
  case "menu-noop": code = await runMenu({ repository: { analyze: async () => ({ repositoryName: "repo", baseBranch: "main", currentBranch: "main", branches: [] }), configuredRemotes: async () => [] }, base: undefined, prompts: { action: async () => "exit", remote: async () => "origin" }, runners: {}, output }); break;
  case "menu-error": code = await runMenu({ repository: { analyze: async () => { throw new Error("root analysis failed"); }, configuredRemotes: async () => [] }, prompts: { action: async () => "exit", remote: async () => "origin" }, runners: {}, output }); break;
  case "prune-success": code = await runPrune({ repository: { resolvePruneTarget: async () => ({ name: "origin", urls: [], fetchRepository: "origin" }), previewPrune: async () => ({ stdout: "", stderr: "" }), executePrune: async () => ({ stdout: "", stderr: "" }) }, prompts: { confirm: async () => true }, output, dryRun: false, interactive: true }); break;
  case "prune-error": code = await runPrune({ repository: { resolvePruneTarget: async () => { throw new Error("prune resolution failed"); }, previewPrune: async () => ({ stdout: "", stderr: "" }), executePrune: async () => ({ stdout: "", stderr: "" }) }, prompts: { confirm: async () => true }, output, dryRun: false, interactive: true }); break;
  case "clean-success": code = await runClean({ repository: { analyze: async () => ({ repositoryName: "repo", baseBranch: "main", currentBranch: "main", branches: [branch] }), revalidate: async () => ({ eligible: true }), branchOid: async () => "a".repeat(40), deleteBranch: async () => {} }, prompts: { select: async () => ["topic"], confirm: async () => true }, output, dryRun: false, interactive: true }); break;
  case "clean-error": code = await runClean({ repository: { analyze: async () => { throw new Error("local analysis failed"); }, revalidate: async () => ({ eligible: true }), deleteBranch: async () => {} }, prompts: { select: async () => [], confirm: async () => false }, output, dryRun: false, interactive: true }); break;
  case "remote-clean-success": code = await runRemoteClean({ repository: { resolveRemoteDeletionTarget: async () => ({ name: "origin", urls: [], inventoryRepository: "origin" }), analyzeRemoteDeletion: async () => ({ remote: "origin", urls: [], candidates: [remoteBranch] }), revalidateRemoteDeletion: async (_target, selected) => [...selected], deleteRemoteBranches: async () => ({ stdout: "", stderr: "" }) }, prompts: { select: async () => ["origin/topic"], confirm: async () => true, input: async () => "origin" }, output, remote: "origin", dryRun: false, interactive: true }); break;
  case "remote-clean-error": code = await runRemoteClean({ repository: { resolveRemoteDeletionTarget: async () => { throw new Error("remote resolution failed"); }, analyzeRemoteDeletion: async () => ({ remote: "origin", urls: [], candidates: [] }), revalidateRemoteDeletion: async () => [], deleteRemoteBranches: async () => ({ stdout: "", stderr: "" }) }, prompts: { select: async () => [], confirm: async () => false, input: async () => "" }, output, remote: "origin", dryRun: false, interactive: true }); break;
  case "undo-restore-success": code = await runUndo({ history: { acquire: async () => lock, reconcilePending: async () => [operation], select: async () => operation, beginRestore: async () => operation, localExists: async () => false, objectExists: async () => true, restoreLocal: async () => {}, remove: async () => {} }, repository: {}, prompts: { confirm: async () => true, input: async () => "" }, output, interactive: true, list: false }); break;
  case "undo-discard-success": code = await runUndo({ history: { acquire: async () => lock, reconcilePending: async () => [operation], select: async () => operation, remove: async () => {} }, repository: {}, prompts: { confirm: async () => true, input: async () => "" }, output, interactive: true, list: false, discard: operation.id }); break;
  case "undo-restore-error": code = await runUndo({ history: { acquire: async () => { throw new Error("undo restore lock failed"); } }, repository: {}, prompts: { confirm: async () => true, input: async () => "" }, output, interactive: true, list: false }); break;
  case "undo-discard-error": code = await runUndo({ history: { acquire: async () => { throw new Error("undo discard lock failed"); } }, repository: {}, prompts: { confirm: async () => true, input: async () => "" }, output, interactive: true, list: false, discard: operation.id }); break;
  default: throw new Error(`unknown scenario ${scenario}`);
}
process.stdout.write(`${JSON.stringify({ code, stdout, stderr })}\n`);
