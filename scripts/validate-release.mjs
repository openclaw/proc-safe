import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { nativeTargets, nativePackageDirectory } from "./native-targets.mjs";
const tag = process.env.RELEASE_TAG;
assert.match(tag ?? "", /^v\d+\.\d+\.\d+$/);
const dryRun = process.env.DRY_RUN === "true";
let commit;
if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
  assert.ok(dryRun, "manual runs must be dry runs");
  assert.equal(process.env.GITHUB_REF, "refs/heads/main", "dry runs must use main");
  commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} else {
  assert.ok(!dryRun, "dry runs require manual dispatch");
  assert.equal(execFileSync("git", ["cat-file", "-t", `refs/tags/${tag}`], { encoding: "utf8" }).trim(), "tag");
  commit = execFileSync("git", ["rev-parse", `${tag}^{commit}`], { encoding: "utf8" }).trim();
}
assert.equal(execFileSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).trim(), commit, "release must point to latest main");
const root = JSON.parse(readFileSync("package.json", "utf8"));
const version = tag.slice(1);
assert.equal(root.version, version);
assert.equal(JSON.parse(readFileSync("native/package.json", "utf8")).version, version);
assert.ok(readFileSync("native/Cargo.toml", "utf8").includes(`\nversion = "${version}"\n`));
for (const target of nativeTargets) {
  const pkg = JSON.parse(readFileSync(new URL("package.json", nativePackageDirectory(target)), "utf8"));
  assert.equal(pkg.version, version);
  assert.equal(root.optionalDependencies[pkg.name], version);
}
execFileSync(process.execPath, ["scripts/release-notes.mjs", version], { stdio: "inherit" });
