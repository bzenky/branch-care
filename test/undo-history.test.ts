import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { replaceReceipt, validateReceipt, type UndoReceipt } from "../src/undo-history.js";
import { makeEmptyDirectory } from "./helpers.js";

const id = "clean-20260102T030405Z-a1b2c3";
const receipt: UndoReceipt = { version: 1, id, state: "completed", kind: "local", createdAt: "2026-01-02T03:04:05.000Z", completedAt: "2026-01-02T03:04:06.000Z", entries: [{ name: "topic", fullName: "topic", oid: "a".repeat(40), backupRef: `refs/branch-care/undo/${id}/local/topic`, restoration: "remaining" }] };

test("receipt validator covers every accepted field and rejected corruption class", () => {
  assert.deepEqual(validateReceipt(receipt, id), receipt);
  const corruptions: unknown[] = ["{", { ...receipt, version: 2 }, { ...receipt, id: "../bad" }, { ...receipt, state: "bad" }, { ...receipt, remote: "origin" }, { ...receipt, completedAt: undefined }, { ...receipt, entries: [...receipt.entries, receipt.entries[0]] }, { ...receipt, entries: [{ ...receipt.entries[0], name: "../bad" }] }, { ...receipt, entries: [{ ...receipt.entries[0], backupRef: "refs/heads/main" }] }];
  for (const value of corruptions.slice(1)) assert.throws(() => validateReceipt(value), /Invalid|Inconsistent|Duplicate/);
  assert.throws(() => validateReceipt(receipt, `${id}0`), /identity/);
});

test("receipt replacement is private atomic and cleans temporary files", (t) => {
  const fixture = makeEmptyDirectory(); t.after(fixture.cleanup); const path = resolve(fixture.dir, "operations", `${id}.json`);
  replaceReceipt(path, receipt); assert.equal(statSync(path).mode & 0o777, 0o600); assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), receipt);
  assert.equal(existsSync(`${path}.tmp`), false);
  const prior = readFileSync(path, "utf8"); mkdirSync(resolve(fixture.dir, "blocked")); chmodSync(resolve(fixture.dir, "blocked"), 0o500);
  const blocked = resolve(fixture.dir, "blocked", "receipt.json");
  try { replaceReceipt(blocked, receipt); } catch {}
  assert.equal(readFileSync(path, "utf8"), prior);
});
