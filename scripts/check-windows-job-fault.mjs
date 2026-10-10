import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { hostNativeTarget } from "./native-targets.mjs";

assert.equal(process.platform, "win32");
const target = hostNativeTarget();
const require = createRequire(import.meta.url);
const productionPath = require.resolve(target.package);
const production = readFileSync(productionPath);
assert.ok(!production.includes(Buffer.from("failNextWindowsJobAssignment")));
assert.equal(Object.hasOwn(require(productionPath), "failNextWindowsJobAssignment"), false);
assert.equal(Object.hasOwn(require(productionPath), "inspectWindowsPinAccess"), false);
const directory = resolve("target/job-fault");
const addon = resolve(directory, "proc-safe-job-fault.node");
if (!process.argv.includes("--test-only")) {
  execFileSync("cargo", ["build", "--locked", "--release", "--lib", "--target", target.rust,
    "--target-dir", directory, "--no-default-features", "--features", "fault-injection"], { stdio: "inherit" });
  copyFileSync(resolve(directory, target.rust, "release/proc_safe_native.dll"), addon);
}
assert.ok(readFileSync(addon).includes(Buffer.from("failNextWindowsJobAssignment")));
const result = execFileSync(process.execPath, ["scripts/windows-job-proof.mjs", "fault-proof"], {
  encoding: "utf8", timeout: 60_000,
  env: { ...process.env, PROC_SAFE_TEST_JOB_FAULT_ADDON: addon, PROC_SAFE_NATIVE: "require" },
});
assert.deepEqual(JSON.parse(result), { faultProof: 2, accessProof: 2 });
assert.deepEqual(readFileSync(productionPath), production, "fault build must not replace production addon");
console.log("Separate fault addon: main/Worker rollback and exact granted-access masks passed; production artifact excludes test hooks");
