import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createCanonical } from "./release-package.mjs";

const output = mkdtempSync(resolve(tmpdir(), "branch-care-smoke-"));
try {
  const result = createCanonical({ output });
  console.log(`package smoke passed: ${result.paths.length} exact files, SHA-256 ${result.hash}`);
} catch (error) {
  console.error(`package smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(output, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
