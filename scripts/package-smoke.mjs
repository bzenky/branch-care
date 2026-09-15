import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(resolve(tmpdir(), "branch-care-package-"));

try {
  const packOutput = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", temporaryRoot],
    { cwd: projectRoot, encoding: "utf8" }
  );
  const [packed] = JSON.parse(packOutput);
  assert.ok(packed?.filename, "npm pack did not return a filename");

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
  execFileSync("npm", ["install", "--ignore-scripts", tarball], { cwd: consumer, stdio: "inherit" });

  const executable = resolve(consumer, "node_modules", ".bin", process.platform === "win32" ? "branch-care.cmd" : "branch-care");
  const manifest = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8"));

  const version = spawnSync(executable, ["--version"], { cwd: consumer, encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), manifest.version);

  const bare = spawnSync(executable, [], { cwd: consumer, encoding: "utf8" });
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /Usage: branch-care/);
  assert.match(bare.stdout, /status \[options\]/);
  assert.match(bare.stdout, /clean \[options\]/);

  console.log(`package smoke passed: ${packed.filename}, ${packed.files.length} files`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
