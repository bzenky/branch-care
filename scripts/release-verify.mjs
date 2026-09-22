import { packageName, packageVersion, verifyCanonical } from "./release-package.mjs";

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

try {
  const result = verifyCanonical({ artifact: valueAfter("--artifact"), checksum: valueAfter("--checksum") });
  console.log(`${packageName}@${packageVersion}`);
  console.log(`SHA-256 ${result.hash}`);
  console.log(`Verified ${result.paths.length} package files and all consumer paths`);
} catch (error) {
  console.error(`release package verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
