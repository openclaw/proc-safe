import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";

test("native status reports real loading and isolated installation failures on main and Worker", () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const result = JSON.parse(execFileSync(process.execPath, ["scripts/native-status-proof.mjs"], {
    encoding: "utf8", timeout: 30_000, env,
  }));
  expect(result.contexts).toEqual(["main", "worker"]);
  expect(result.observations).toContain("package-missing");
  expect(result.observations).toContain("load-failed");
  if (process.env.PROC_SAFE_NATIVE === "require") expect(result.observations).toContain("loaded");
});
