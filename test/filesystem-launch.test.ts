import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { prepareFilesystemRestrictedLaunch } from "../src/filesystem-launch.js";

const options = { executable: process.execPath, readOnlyPaths: ["/"], readWritePaths: [] };

test.runIf(process.platform !== "linux")("filesystem launch refuses unsupported platforms", () => {
  expect(() => prepareFilesystemRestrictedLaunch(options)).toThrow(expect.objectContaining({ code: "unsupported-platform" }));
});

test.runIf(process.platform === "linux")("invalid paths and target environment fail before helper resolution", () => {
  for (const invalid of [
    { executable: "relative" },
    { readWritePaths: ["relative"] },
    { args: ["nul\0argument"] },
    { env: { "": "value" } },
    { env: { "BAD=KEY": "value" } },
    { env: { VALID: "nul\0value" } },
  ]) {
    expect(() => prepareFilesystemRestrictedLaunch({ ...options, ...invalid })).toThrow(expect.objectContaining({ code: "invalid-argument" }));
  }
});

test.runIf(process.platform === "linux" && process.env.PROC_SAFE_NATIVE === "require")("real filesystem boundary, exec inheritance and failed setup on main and Worker", () => {
  const result = execFileSync(process.execPath, ["scripts/filesystem-launch-proof.mjs"], { encoding: "utf8", timeout: 10_000 });
  expect(result.trim()).toBe("filesystem launch: main and Worker passed");
});
