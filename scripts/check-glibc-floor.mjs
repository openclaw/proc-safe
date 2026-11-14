import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function verifyGlibcFloor(symbols, floor) {
  assert.match(floor, /^\d+\.\d+$/, "glibc floor must be major.minor");
  const maximum = floor.split(".").map(Number);
  const versions = [...new Set(symbols.match(/\bGLIBC_[A-Za-z0-9_.]+\b/g) ?? [])];
  assert.ok(versions.length > 0, "no glibc symbol versions found");
  for (const version of versions) {
    assert.match(version, /^GLIBC_\d+\.\d+(?:\.\d+)?$/, `unsupported glibc version: ${version}`);
    const parts = version.slice(6).split(".").map(Number);
    const supported = parts[0] < maximum[0] || (parts[0] === maximum[0] &&
      (parts[1] < maximum[1] || (parts[1] === maximum[1] && (parts[2] ?? 0) === 0)));
    assert.ok(supported, `${version} exceeds glibc ${floor}`);
  }
  return versions.sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [floor, ...files] = process.argv.slice(2);
  assert.ok(files.length > 0, "usage: check-glibc-floor.mjs <major.minor> <binary> [...]");
  for (const file of files) {
    const versions = verifyGlibcFloor(execFileSync("objdump", ["-T", file], { encoding: "utf8" }), floor);
    console.log(`${file}: ${versions.join(", ")} (floor ${floor})`);
  }
}
