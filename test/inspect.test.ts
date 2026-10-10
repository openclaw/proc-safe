import { execFileSync } from "node:child_process";
import { test, expect } from "vitest";
import { readProcessCommand } from "../src/inspect.js";

test.each([0, -1, 1.2, NaN, Infinity, 0x1_0000_0000])("inspection rejects invalid PID %s", pid => {
  expect(() => readProcessCommand(pid)).toThrow(expect.objectContaining({ code: "invalid-argument" }));
});

test.each(["", "a=b", "a\0b"]) ("inspection rejects invalid environment key %j", key => {
  expect(() => readProcessCommand(process.pid, { environmentKeys: [key] })).toThrow(expect.objectContaining({ code: "invalid-argument" }));
});

test.runIf(process.env.PROC_SAFE_NATIVE === "require")("real command inspection and Worker boundary", () => {
  const output = execFileSync(process.execPath, ["scripts/inspect-proof.mjs"], { encoding: "utf8", timeout: 10_000 });
  expect(JSON.parse(output)).toMatchObject({ platform: process.platform, arch: process.arch, passed: process.platform === "darwin" ? 6 : process.platform === "win32" ? 5 : 1 });
});
