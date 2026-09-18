import assert from "node:assert/strict";
import test from "node:test";
import { packageJson } from "./helpers.js";

test("manifest freezes package runtime identity", () => {
  const pkg = packageJson();
  assert.equal(pkg.name, "branch-care");
  assert.equal(pkg.private, true);
  assert.equal((pkg.bin as Record<string, string>)["branch-care"], "./dist/src/index.js");
  assert.equal((pkg.engines as Record<string, string>).node, ">=22");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.deepEqual(pkg.files, ["dist/src"]);
  assert.equal((pkg.repository as Record<string, string>).url, "git+https://github.com/bzenky/branch-care.git");
  assert.equal(pkg.homepage, "https://github.com/bzenky/branch-care#readme");
  assert.equal((pkg.bugs as Record<string, string>).url, "https://github.com/bzenky/branch-care/issues");
});

test("runtime dependencies match approved doors", () => {
  const dependencies = packageJson().dependencies as Record<string, string>;
  assert.ok(dependencies.commander);
  assert.ok(dependencies["@inquirer/prompts"]);
  assert.deepEqual(Object.keys(dependencies).sort(), ["@inquirer/prompts", "commander"]);
});

test("Windows PTY remains development-only", () => {
  const pkg = packageJson();
  const dependencies = pkg.dependencies as Record<string, string>;
  const devDependencies = pkg.devDependencies as Record<string, string>;
  assert.ok(devDependencies["@homebridge/node-pty-prebuilt-multiarch"]);
  assert.equal(dependencies["@homebridge/node-pty-prebuilt-multiarch"], undefined);
});

test("package remains private until the V1 release gate", () => {
  const pkg = packageJson();
  assert.equal(pkg.private, true);
  assert.equal(pkg.version, "0.1.0");
  assert.equal((pkg.engines as Record<string, string>).node, ">=22");
  assert.deepEqual(Object.keys(pkg.dependencies as Record<string, string>).sort(), ["@inquirer/prompts", "commander"]);
});

test("configuration uses native JSON and wildcard matching", () => {
  const dependencies = packageJson().dependencies as Record<string, string>;
  assert.deepEqual(Object.keys(dependencies).sort(), ["@inquirer/prompts", "commander"]);
  assert.equal(Object.keys(dependencies).some((name) => /json|glob|minimatch|micromatch/i.test(name)), false);
});

test("JSON status uses native serialization and Git facts", () => {
  const dependencies = packageJson().dependencies as Record<string, string>;
  assert.deepEqual(Object.keys(dependencies).sort(), ["@inquirer/prompts", "commander"]);
  assert.equal(Object.keys(dependencies).some((name) => /json|schema|remote|git/i.test(name)), false);
});
