import assert from "node:assert/strict";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { GitClient } from "../src/git/client.js";
import { replaceReceipt, UndoHistory, validateReceipt, type UndoReceipt } from "../src/undo-history.js";
import { makeEmptyDirectory, makeRepo } from "./helpers.js";

const id = "clean-20260102T030405Z-a1b2c3";
const receipt: UndoReceipt = { version: 1, id, state: "completed", kind: "local", createdAt: "2026-01-02T03:04:05.000Z", completedAt: "2026-01-02T03:04:06.000Z", entries: [{ name: "topic", fullName: "topic", oid: "a".repeat(40), backupRef: `refs/branch-care/undo/${id}/local/topic`, restoration: "remaining" }] };

test("receipt validator covers every accepted field and rejected corruption class", () => {
  assert.deepEqual(validateReceipt(receipt, id), receipt);
  const remote: UndoReceipt = { ...receipt, kind: "remote", remote: "origin", remoteEndpoint: "/srv/repo.git", urls: ["https://example.test/repo.git"], entries: [{ ...receipt.entries[0]!, fullName: "origin/topic", backupRef: `refs/branch-care/undo/${id}/remote/topic` }] };
  assert.deepEqual(validateReceipt(remote, id), remote);
  assert.throws(() => validateReceipt(JSON.parse("{")), SyntaxError, "malformed JSON must be parsed and rejected");
  const corruptions: Array<[string, unknown]> = [
    ["unsupported version", { ...receipt, version: 2 }],
    ["invalid opaque ID", { ...receipt, id: "../bad" }],
    ["unsupported state", { ...receipt, state: "bad" }],
    ["unsupported kind", { ...receipt, kind: "other" }],
    ["kind/remote inconsistency", { ...receipt, remote: "origin" }],
    ["remote missing endpoint", { ...remote, remoteEndpoint: undefined }],
    ["invalid created instant", { ...receipt, createdAt: "2026-99-99T03:04:05.000Z" }],
    ["invalid completed instant", { ...receipt, completedAt: "not-utc" }],
    ["completion/state inconsistency", { ...receipt, completedAt: undefined }],
    ["empty entries", { ...receipt, entries: [] }],
    ["duplicate entry ID", { ...receipt, entries: [...receipt.entries, receipt.entries[0]] }],
    ["path escape", { ...receipt, entries: [{ ...receipt.entries[0], name: "../bad", fullName: "../bad", backupRef: `refs/branch-care/undo/${id}/local/../bad` }] }],
    ["ref escape", { ...receipt, entries: [{ ...receipt.entries[0], backupRef: "refs/heads/main" }] }],
    ["display inconsistency", { ...receipt, entries: [{ ...receipt.entries[0], fullName: "other" }] }],
    ["invalid OID", { ...receipt, entries: [{ ...receipt.entries[0], oid: "abc" }] }],
    ["invalid restoration", { ...receipt, entries: [{ ...receipt.entries[0], restoration: "restored" }] }]
  ];
  for (const [name, value] of corruptions) assert.throws(() => validateReceipt(value), /Invalid|Inconsistent|Duplicate/, name);
  assert.throws(() => validateReceipt(receipt, `${id}0`), /identity/, "filename ID must equal receipt ID");
});

test("receipt replacement is private atomic and cleans temporary files", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); const paths = await new UndoHistory(new GitClient(fixture.dir)).paths();
  const path = resolve(paths.operations, `${id}.json`); replaceReceipt(path, receipt); const status = statSync(path);
  assert.equal(dirname(dirname(paths.root)), paths.commonDir); assert.equal(status.isFile(), true);
  if (process.platform !== "win32") assert.equal(status.mode & 0o777, 0o600);
  assert.deepEqual(validateReceipt(JSON.parse(readFileSync(path, "utf8")), id), receipt);
  const prior = readFileSync(path, "utf8");
  for (const failure of ["write", "rename"] as const) {
    const events: string[] = []; let temporary = "";
    assert.throws(() => replaceReceipt(path, { ...receipt, createdAt: "2026-01-02T03:04:07.000Z" }, {
      open: (candidate) => { temporary = candidate; events.push("open"); return openSync(candidate, "wx", 0o600); },
      write: (fd, contents) => { events.push("write"); if (failure === "write") throw new Error("injected write failure"); writeFileSync(fd, contents, "utf8"); },
      close: (fd) => { events.push("close"); closeSync(fd); },
      rename: (from, to) => { events.push("rename"); if (failure === "rename") throw new Error("injected rename failure"); throw new Error(`unexpected rename ${from} ${to}`); },
      remove: (candidate) => { events.push("remove"); rmSync(candidate, { force: true }); }
    }), new RegExp(`injected ${failure} failure`));
    assert.equal(readFileSync(path, "utf8"), prior, `${failure} failure must preserve prior receipt bytes`);
    assert.equal(existsSync(temporary), false, `${failure} failure must remove generated temporary file`);
    assert.deepEqual(events, failure === "write" ? ["open", "write", "close", "remove"] : ["open", "write", "close", "rename", "remove"]);
  }
  assert.deepEqual(readdirSync(paths.operations), [`${id}.json`]);
});
