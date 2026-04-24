const { readdirSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const testsDir = join(process.cwd(), "dist", "src", "tests");
const tests = readdirSync(testsDir)
  .filter((file) => file.endsWith(".js"))
  .sort();

if (tests.length === 0) {
  console.error(`No compiled tests found in ${testsDir}. Run npm run build first.`);
  process.exit(1);
}

for (const test of tests) {
  const result = spawnSync(process.execPath, [join(testsDir, test)], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`Compiled test failed: ${test}`);
    process.exit(result.status ?? 1);
  }
}

console.log(`compiled-tests-passed=${tests.length}`);
