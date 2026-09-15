import assert from "node:assert/strict";
import test from "node:test";
import { sortBranches } from "../src/ui/output.js";

test("branch groups use bytewise ascending order", () => {
  const names = ["zeta", "éclair", "alpha", "Zebra", "feature/x"];
  assert.deepEqual(sortBranches(names), ["Zebra", "alpha", "feature/x", "zeta", "éclair"]);
});
