import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertExit, cliPath, makeRepo, packageJson, refs, runCli } from "./helpers.js";

test("help exposes the approved command grammar", () => {
  const result = runCli(process.cwd(), ["--help"]); assertExit(result, 0);
  assert.match(result.stdout, /status \[options\]/);
  assert.match(result.stdout, /clean \[options\]/);
  assert.match(result.stdout, /remote \[options\]/);
  assert.match(result.stdout, /--base <branch>/);
  const bare = runCli(process.cwd(), []); assertExit(bare, 0);
  assert.equal(bare.stdout, result.stdout);
  const clean = runCli(process.cwd(), ["clean", "--help"]); assertExit(clean, 0);
  assert.match(clean.stdout, /--dry-run/);
  assert.match(clean.stdout, /--base <branch>/);
});

test("help documents remote inspection", () => {
  const root = runCli(process.cwd(), ["--help"]); assertExit(root, 0);
  const remote = runCli(process.cwd(), ["remote", "--help"]); assertExit(remote, 0);
  assert.match(root.stdout, /^  remote \[options\]  inspect locally known remote branches$/m);
  assert.match(remote.stdout, /--base <branch>/);
  assert.match(remote.stdout, /inspect locally known remote branches/);
});

test("help documents repository configuration", () => {
  const root = runCli(process.cwd(), ["--help"]); assertExit(root, 0);
  const config = runCli(process.cwd(), ["config", "--help"]); assertExit(config, 0);
  assert.match(root.stdout, /^  config \[options\]  inspect or update repository \.branch-care\.json configuration$/m);
  const required = ["config", "--base <branch>", ".branch-care.json", "baseBranch", "staleAfterDays", "protectedBranches"];
  for (const [route, stdout] of [["root", root.stdout], ["config", config.stdout]]) {
    for (const text of required) assert.ok(stdout.includes(text), `${route} help must include ${text}`);
  }
});

test("version matches the package", (t) => {
  const result = runCli(process.cwd(), ["--version"]); assertExit(result, 0);
  assert.equal(result.stdout.trim(), packageJson().version);

  const directory = mkdtempSync(resolve(tmpdir(), "branch-care-bin-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const linkedCli = resolve(directory, "branch-care");
  symlinkSync(cliPath, linkedCli);
  const linkedResult = spawnSync(process.execPath, [linkedCli, "--version"], { encoding: "utf8" });
  assertExit(linkedResult, 0);
  assert.equal(linkedResult.stdout.trim(), packageJson().version);
});

test("invalid command and option exit two", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  const before = refs(fixture.dir);
  for (const args of [["unknown"], ["status", "--invalid"], ["clean", "--invalid"]]) {
    const result = runCli(fixture.dir, args); assertExit(result, 2);
    assert.match(result.stderr, /Usage:/i);
  }
  assert.equal(refs(fixture.dir), before);
});

test("status help documents versioned JSON", () => {
  const result = runCli(process.cwd(), ["status", "--help"]); assertExit(result, 0);
  assert.match(result.stdout, /--json/);
  assert.match(result.stdout, /versioned machine-readable output/i);
});

test("human status usage errors remain exit two", (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup);
  for (const args of [["status", "--unknown"], ["status", "--base"]]) {
    const result = runCli(fixture.dir, args); assertExit(result, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage:/i);
  }
});
