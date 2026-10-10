import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";

// This suite is enabled by a real build, never by a mock binding.
test.runIf(process.env.PROC_SAFE_NATIVE === "require")("real process and Worker boundary", () => {
  const result = execFileSync(process.execPath, ["scripts/runtime-proof.mjs"], { encoding: "utf8", timeout: 10_000 });
  expect(JSON.parse(result)).toMatchObject({ platform: process.platform, arch: process.arch, passed: 6 });
});
