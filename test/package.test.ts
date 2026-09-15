import assert from "node:assert/strict";
import test from "node:test";
import { packageJson } from "./helpers.js";

test("manifest freezes package runtime identity", () => {
  const pkg = packageJson();
  assert.equal(pkg.name, "branch-care");
  assert.equal((pkg.bin as Record<string, string>)["branch-care"], "./dist/src/index.js");
  assert.equal((pkg.engines as Record<string, string>).node, ">=22");
  assert.equal(pkg.type, "module");
  assert.deepEqual(pkg.files, ["dist/src"]);
});

test("runtime dependencies match approved doors", () => {
  const dependencies = packageJson().dependencies as Record<string, string>;
  assert.ok(dependencies.commander);
  assert.ok(dependencies["@inquirer/prompts"]);
  assert.deepEqual(Object.keys(dependencies).sort(), ["@inquirer/prompts", "commander"]);
});
