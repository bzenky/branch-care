import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { projectRoot } from "./helpers.js";

test("README documents the configuration contract", () => {
  const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");
  for (const text of [
    ".branch-care.json", "baseBranch", "staleAfterDays", "protectedBranches",
    "repository root", "--base <branch>", "origin/HEAD", "additive", "zero or more",
    "including `/`", "invalid", "exit code `1`", "branch-care config", "branch-care config --base"
  ]) assert.ok(readme.includes(text), `README must include ${text}`);
  assert.ok(readme.includes([
    "1. `--base <branch>`",
    "2. Repository `baseBranch` from `.branch-care.json`",
    "3. Local branch referenced by `origin/HEAD`",
    "4. `main`",
    "5. `master`",
    "6. `develop`"
  ].join("\n")), "README must document CLI > repository > origin/HEAD > main > master > develop");
});
