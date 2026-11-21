import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";

test.runIf(process.platform === "darwin" && process.env.PROC_SAFE_NATIVE === "require")("protected Darwin identity matches the exact kernel birth on main and Worker", () => {
  expect(execFileSync(process.execPath, ["scripts/darwin-kernel-identity-proof.mjs"], { encoding: "utf8", timeout: 15_000 }))
    .toContain("protected Darwin kernel identities verified on main and Worker");
});
