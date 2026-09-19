import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import test from "node:test";
import { branch, findExecutable, makeEmptyDirectory, makeRepo, prependPath, projectRoot, runCliInteractive, withPrependedPath, writeNodeLauncher } from "./helpers.js";

test("interactive harness uses one cross-platform PTY implementation", () => {
  const helperSource = readFileSync(resolve(projectRoot, "test/helpers.ts"), "utf8");
  const driverSource = readFileSync(resolve(projectRoot, "test/pty-driver.mjs"), "utf8");
  assert.doesNotMatch(helperSource, /@homebridge\/node-pty-prebuilt-multiarch/);
  assert.match(driverSource, /@homebridge\/node-pty-prebuilt-multiarch/);
  assert.doesNotMatch(`${helperSource}\n${driverSource}`, /spawn\(["'](?:script|expect)["']|\/dev\/null|shellQuote|tclBytes/);
});

test("interactive harness sequences exact prompts and returns exit status", async (t) => {
  const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "merged");
  const result = await runCliInteractive(fixture.dir, ["clean"], [
    { waitFor: "Branches safe to delete:", input: "\r" },
    { waitFor: "Delete 1 branch?", input: "\r" }
  ]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Branches safe to delete:.*Delete 1 branch\?.*No branches were removed\./s);
  assert.equal(result.stdout.includes("\r"), false);
  assert.equal(result.stderr, "");
});

test("interactive harness reports spawn exit and timeout failures", async (t) => {
  const source = readFileSync(resolve(projectRoot, "test/helpers.ts"), "utf8");
  assert.match(source, /timeoutMs = 15_000/);
  const missing = makeEmptyDirectory(); missing.cleanup();
  await assert.rejects(runCliInteractive(missing.dir, ["--help"], []), /ENOENT|directory|cwd|path/i);
  await assert.rejects(runCliInteractive(projectRoot, ["--help"], [{ waitFor: "never appears", input: "x" }]), /exited before interaction 1.*Usage: branch-care/s);
  const fixture = makeRepo(); t.after(fixture.cleanup); branch(fixture.dir, "merged");
  await assert.rejects(runCliInteractive(fixture.dir, ["clean"], [{ waitFor: "never appears", input: "x" }], 50), /timed out before interaction 1/);
});

test("executable discovery is delimiter and suffix aware", (t) => {
  const first = makeEmptyDirectory("branch-care-path-space-"); const second = makeEmptyDirectory();
  t.after(first.cleanup); t.after(second.cleanup);
  const unix = resolve(second.dir, "git"); writeFileSync(unix, ""); chmodSync(unix, 0o755);
  assert.equal(findExecutable("git", `${first.dir}${delimiter}${second.dir}`, "linux"), unix);
  const windows = resolve(first.dir, "git.cmd"); writeFileSync(windows, "@echo off\r\n");
  assert.equal(findExecutable("git", `${first.dir}${delimiter}${second.dir}`, "win32"), windows);
});


test("fake Git launcher preserves interception delegation and audit", () => {
  const fixture = makeEmptyDirectory();
  const audit = resolve(fixture.dir, "audit.jsonl");
  const launcher = writeNodeLauncher(fixture.dir, "git", `
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(audit)}, JSON.stringify(args) + "\\n");
if (args[0] === "intercept") process.exit(23);
const delegated = spawnSync(process.execPath, ["-e", "process.stdout.write('delegated')"], { stdio: "inherit" });
process.exit(delegated.status ?? 1);
`, "win32");
  const intercepted = (() => {
    try { execFileSync(process.execPath, [launcher, "intercept", "branch with space"]); return 0; }
    catch (error) { return (error as { status?: number }).status; }
  })();
  assert.equal(intercepted, 23);
  assert.equal(execFileSync(process.execPath, [launcher, "delegate"], { encoding: "utf8" }), "delegated");
  assert.deepEqual(readFileSync(audit, "utf8").trim().split("\n").map((line) => JSON.parse(line)), [
    ["intercept", "branch with space"], ["delegate"]
  ]);
  assert.match(readFileSync(resolve(fixture.dir, "git.cmd"), "utf8"), /node(?:\.exe)?" "[^"]*git-wrapper\.cjs" %\*/i);
  const unix = makeEmptyDirectory();
  const unixLauncher = writeNodeLauncher(unix.dir, "git", "process.exit(0);\n", "linux");
  assert.equal(existsSync(unixLauncher), true);
  assert.equal(existsSync(resolve(unix.dir, "git.cmd")), false);
  fixture.cleanup(); unix.cleanup();
  assert.equal(existsSync(fixture.dir), false);
  assert.equal(existsSync(unix.dir), false);
});

test("fake Git environment prepends PATH portably", () => {
  assert.equal(prependPath("wrapper", `one${delimiter}two`), `wrapper${delimiter}one${delimiter}two`);
  assert.equal(prependPath("wrapper", ""), "wrapper");
  const original = { PATH: `one${delimiter}two`, SENTINEL: "preserved" };
  assert.deepEqual(withPrependedPath("wrapper", original), { PATH: `wrapper${delimiter}one${delimiter}two`, SENTINEL: "preserved" });
  assert.deepEqual(original, { PATH: `one${delimiter}two`, SENTINEL: "preserved" });
});
