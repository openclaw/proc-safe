import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";

const env = { ...process.env };
delete env.NODE_OPTIONS;
delete env.NODE_PATH;

test("Windows token capability fails explicitly when disabled on main and Worker", () => {
  const result = JSON.parse(execFileSync(process.execPath, ["scripts/windows-token-proof.mjs", "--disabled"], {
    encoding: "utf8", timeout: 10_000, env: { ...env, PROC_SAFE_NATIVE: "off" },
  }));
  expect(result).toEqual({ main: "unavailable", worker: "unavailable" });
});

test.runIf(process.env.PROC_SAFE_NATIVE === "require")("real AppContainer facts and denied tokens on main and Worker", () => {
  const result = JSON.parse(execFileSync(process.execPath, ["scripts/windows-token-proof.mjs"], {
    encoding: "utf8", timeout: 70_000, env,
  }));
  expect(result).toMatchObject({ platform: process.platform, passed: process.platform === "win32" ? 4 : 2 });
});
