import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import test from "node:test";
import { branch, findExecutable, makeEmptyDirectory, makeRepo, prependPath, projectRoot, runCliInteractive, writeNodeLauncher } from "./helpers.js";

test("interactive harness uses one cross-platform PTY implementation", () => {
  const helperSource = readFileSync(resolve(projectRoot, "test/helpers.ts"), "utf8");
  const driverSource = readFileSync(resolve(projectRoot, "test/pty-driver.mjs"), "utf8");
  assert.doesNotMatch(helperSource, /@homebridge\/node-pty-prebuilt-multiarch/);
  assert.match(driverSource, /@homebridge\/node-pty-prebuilt-multiarch/);
  assert.doesNotMatch(`${helperSource}\n${driverSource}`, /spawn\(["'](?:script|expect)["']|\/dev\/null|shellQuote|tclBytes/);
});

test("interactive harness sequences exact prompts and returns exit status", async () => {
  const result = await runCliInteractive(projectRoot, ["--help"], []);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: branch-care/);
  assert.equal(result.stderr, "");
});

test("interactive harness reports spawn exit and timeout failures", async (t) => {
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

test("fake Git launcher preserves interception delegation and audit", (t) => {
  const fixture = makeEmptyDirectory(); t.after(fixture.cleanup);
  writeNodeLauncher(fixture.dir, "git", "process.exit(0);\n");
  assert.equal(existsSync(resolve(fixture.dir, process.platform === "win32" ? "git.cmd" : "git")), true);
});

test("fake Git environment prepends PATH portably", () => {
  assert.equal(prependPath("wrapper", `one${delimiter}two`), `wrapper${delimiter}one${delimiter}two`);
  assert.equal(prependPath("wrapper", ""), "wrapper");
});
