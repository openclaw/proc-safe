import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { becomeChildSubreaper, inspectChildWaitState, isChildSubreaper, reapChild } from "../src/reaper.js";

test.each([0, -1, 1.5, NaN, Infinity, 0x1_0000_0000])("reaper rejects invalid PID %s", pid => {
  for (const call of [inspectChildWaitState, reapChild]) {
    expect(() => call(pid)).toThrow(expect.objectContaining({ code: "invalid-argument" }));
  }
});

test("reaper respects the host PID range before platform gating", () => {
  const code = process.platform === "win32" ? "unsupported-platform" : "invalid-argument";
  for (const call of [inspectChildWaitState, reapChild]) {
    expect(() => call(0x80000000)).toThrow(expect.objectContaining({ code }));
  }
});

test("reaper imports lazily and respects disabled native loading", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    process.dlopen = () => { throw new Error('native loading disabled'); };
    const r = await import('./dist/reaper.js');
    assert.equal(r.isSupported(), false);
    const code = process.platform === 'linux' ? 'helper-unavailable' : 'unsupported-platform';
    for (const call of [() => r.becomeChildSubreaper(), () => r.isChildSubreaper(),
      () => r.inspectChildWaitState(), () => r.inspectChildWaitState(1), () => r.reapChild(1)]) {
      assert.throws(call, { code });
    }
  `], { encoding: "utf8", env: { ...process.env, PROC_SAFE_NATIVE: "off" } });
  expect(output).toBe("");
});

test.runIf(process.platform !== "linux")("reaper operations reject unsupported platforms", () => {
  for (const call of [becomeChildSubreaper, isChildSubreaper,
    () => inspectChildWaitState(), () => reapChild(1)]) {
    expect(call).toThrow(expect.objectContaining({ code: "unsupported-platform" }));
  }
});

test.runIf(process.platform === "linux" && process.env.PROC_SAFE_NATIVE === "require")(
  "real Node/libuv reaping and adoption on main thread and Worker", () => {
    // The consumer's Node-only ownership gate is intentional. Under the Bun
    // test runner, run this ownership proof with Node rather than claiming Bun support.
    const result = execFileSync(process.versions.bun ? "node" : process.execPath,
      ["scripts/reaper-proof.mjs"], { encoding: "utf8", timeout: 10000 });
    expect(JSON.parse(result)).toEqual({ platform: "linux", arch: process.arch, contexts: 2, scenarios: 10 });
  });
