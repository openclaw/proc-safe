import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const script = fileURLToPath(new URL("../scripts/check-ci-runtime.mjs", import.meta.url));
const [major, minor, patch] = process.versions.node.split(".").map(Number);
const run = (platform: string, arch: string, minimum: string) =>
  spawnSync(process.execPath, [script, platform, arch, minimum], { encoding: "utf8" });

test("CI runtime admission accepts the selected patched floor and records the actual executable", () => {
  for (const minimum of [process.versions.node, `${major}.0.0`]) {
    const result = run(process.platform, process.arch, minimum);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(process.execPath);
    expect(result.stdout).toContain(process.versions.node);
  }
});

test("CI runtime admission rejects a patch below the floor and a different selected major", () => {
  for (const minimum of [`${major}.${minor}.${patch + 1}`, `${major - 1}.0.0`]) {
    const result = run(process.platform, process.arch, minimum);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(minimum);
    expect(result.stderr).toContain(process.execPath);
    expect(result.stderr).toContain("pkg upgrade");
  }
});

test("CI runtime admission rejects mismatched platform or architecture and malformed floors", () => {
  for (const [platform, arch, minimum] of [
    ["wrong-platform", process.arch, process.versions.node],
    [process.platform, "wrong-arch", process.versions.node],
    [process.platform, process.arch, `${major}.0.0-rc.1`],
  ]) {
    const result = run(platform, arch, minimum);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CI runtime rejected");
  }
});
