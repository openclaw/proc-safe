import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolveNpmCli } from "./npm-cli.mjs";
import { normalizePackResult } from "./npm-pack-result.mjs";
import { nativeTargets } from "./native-targets.mjs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const raw = JSON.parse(execFileSync(process.execPath, [resolveNpmCli(), "pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }));
const packed = normalizePackResult(raw, pkg.name);
const files = packed.files.map(f => f.path);
for (const subpath of ["identity", "darwin", "reaper", "diagnostics", "test-support", "index", "errors"]) {
  assert.ok(files.includes(`dist/${subpath}.js`));
  assert.ok(files.includes(`dist/${subpath}.d.ts`));
}
assert.ok(!files.some(f => /(?:\.node$|^native\/|^test\/|^node_modules\/)/.test(f)));
assert.deepEqual(Object.keys(pkg.optionalDependencies).sort(), nativeTargets.map(t => t.package).sort());
assert.equal(nativeTargets.length, 10);
for (const target of nativeTargets) {
  const native = JSON.parse(readFileSync(new URL(`../packages/${target.label}/package.json`, import.meta.url), "utf8"));
  assert.equal(native.name, target.package);
  assert.equal(native.version, pkg.version);
  assert.equal(pkg.optionalDependencies[native.name], pkg.version);
  assert.deepEqual(native.os, [target.os]);
  assert.deepEqual(native.cpu, [target.cpu]);
  assert.deepEqual(native.libc, target.libc ? [target.libc] : undefined);
  assert.equal(native.main, "proc-safe-native.node");
}
console.log(`Packed entry points and ${nativeTargets.length} target manifests verified`);
