import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { runNpm } from "../scripts/npm-cli.mjs";

test("npm runs through the selected Node even when PATH points at another runtime", () => {
  const directory = mkdtempSync(join(tmpdir(), "proc-safe-npm-path-"));
  try {
    for (const command of ["node", "npm"]) {
      const path = join(directory, command + (process.platform === "win32" ? ".cmd" : ""));
      writeFileSync(path, process.platform === "win32" ? "@exit /b 91\r\n" : "#!/bin/sh\nexit 91\n");
      chmodSync(path, 0o755);
    }
    const output = runNpm(["--version"], {
      encoding: "utf8",
      env: { ...process.env, PATH: directory + delimiter + (process.env.PATH ?? "") },
      timeout: 15_000,
    });
    expect(String(output).trim()).toMatch(/^\d+\.\d+\.\d+$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
