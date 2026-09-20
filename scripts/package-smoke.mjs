import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(resolve(tmpdir(), "branch-care-package-"));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "package smoke must run through npm");

try {
  const packOutput = execFileSync(
    process.execPath,
    [npmCli, "pack", "--json", "--pack-destination", temporaryRoot],
    { cwd: projectRoot, encoding: "utf8" }
  );
  const [packed] = JSON.parse(packOutput);
  assert.ok(packed?.filename, "npm pack did not return a filename");

  assert.equal(packed.files.length, 48, `expected 48 package files, received ${packed.files.length}`);
  const publicTopLevelFiles = new Set(["LICENSE", "README.md", "package.json"]);
  for (const file of packed.files) {
    assert.ok(
      publicTopLevelFiles.has(file.path) || file.path.startsWith("dist/src/"),
      `unexpected file in npm package: ${file.path}`
    );
  }

  const consumer = resolve(temporaryRoot, "consumer");
  mkdirSync(consumer);
  writeFileSync(resolve(consumer, "package.json"), '{"name":"branch-care-smoke","private":true}\n');
  const tarball = resolve(temporaryRoot, packed.filename);
  execFileSync(process.execPath, [npmCli, "install", "--ignore-scripts", tarball], { cwd: consumer, stdio: "inherit" });

  const manifest = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8"));
  const executable = resolve(consumer, "node_modules", ".bin", process.platform === "win32" ? "branch-care.cmd" : "branch-care");
  const runInstalled = (args) => spawnSync(executable, args, {
    cwd: consumer,
    encoding: "utf8",
    shell: process.platform === "win32"
  });
  console.log(`package executable: ${executable}`);

  const version = runInstalled(["--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), manifest.version);

  const bare = runInstalled([]);
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /Usage: branch-care/);
  assert.match(bare.stdout, /status \[options\]/);
  assert.match(bare.stdout, /clean \[options\]/);

  const undo = runInstalled(["undo", "--help"]);
  assert.equal(undo.status, 0, undo.stderr);
  assert.match(undo.stdout, /--list/);
  assert.match(undo.stdout, /--discard <operation-id>/);

  console.log(`package smoke passed: ${packed.filename}, ${packed.files.length} files`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
