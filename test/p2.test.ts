import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { samplePageCacheResidency } from "../src/diagnostics.js";
import { spawnDetachedRaw } from "../src/test-support.js";

test.each([-1, 1.5, NaN, Infinity, 0x80000000])("diagnostics rejects invalid fd %s", fd => {
  expect(() => samplePageCacheResidency(fd, { maxPages: 1 })).toThrow(expect.objectContaining({ code: "invalid-argument" }));
});
test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("diagnostics rejects invalid budget %s", maxPages => {
  expect(() => samplePageCacheResidency(0, { maxPages })).toThrow(expect.objectContaining({ code: "invalid-argument" }));
});
test("raw spawn rejects NUL-containing arguments", () => {
  expect(() => spawnDetachedRaw({ executable: "node", args: ["a\0b"] })).toThrow(expect.objectContaining({ code: "invalid-argument" }));
});
test("disabled P2 capabilities never load native code", () => {
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    process.dlopen = () => { throw new Error('disabled addon loaded'); };
    const diagnostics = await import('./dist/diagnostics.js');
    const fixtures = await import('./dist/test-support.js');
    assert.equal(diagnostics.isSupported(), false);
    assert.equal(fixtures.isSupported(), false);
    const code = process.platform === 'linux' ? 'helper-unavailable' : 'unsupported-platform';
    assert.throws(() => diagnostics.samplePageCacheResidency(0, { maxPages: 1 }), { code });
  `], { encoding: "utf8", env: { ...process.env, PROC_SAFE_NATIVE: "off" } });
  expect(result).toBe("");
});
test.runIf(process.env.PROC_SAFE_NATIVE === "require")("real diagnostics and fixture boundaries on main and Worker", () => {
  const result = execFileSync(process.execPath, ["scripts/p2-proof.mjs"], { encoding: "utf8", timeout: 10000 });
  expect(JSON.parse(result)).toMatchObject({ platform: process.platform, arch: process.arch, passed: process.platform === "linux" ? 6 : process.platform === "win32" ? 4 : 2 });
});
