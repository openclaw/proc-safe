import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, Worker, workerData } from "node:worker_threads";
import { childObservationSupported, inspectChildWaitState, isSupported, reapChild } from "../dist/reaper.js";

function verify(code) {
  assert.equal(isSupported(), true);
  assert.throws(() => inspectChildWaitState(), { code });
  assert.throws(() => inspectChildWaitState(process.pid), { code });
  assert.throws(() => reapChild(process.pid), { code });
  assert.equal(childObservationSupported(), false);
  for (const operation of [inspectChildWaitState, reapChild]) {
    assert.throws(() => operation(0), { code: "invalid-argument" });
  }
}

if (!isMainThread) {
  verify(workerData);
} else if (process.argv[2]) {
  const code = process.argv[2];
  verify(code);
  await new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: code });
    worker.once("error", reject);
    worker.once("exit", (exitCode) => exitCode === 0 ? resolve() : reject(new Error(`worker exited ${exitCode}`)));
  });
} else {
  const directory = mkdtempSync(join(tmpdir(), "proc-safe-wait-capability-"));
  try {
    const executable = join(directory, "wait-filter");
    execFileSync("cc", ["-Wall", "-Wextra", "-Werror", "-o", executable,
      fileURLToPath(new URL("../test/fixtures/linux-reaper-capability.c", import.meta.url))]);
    for (const [mode, code] of [["invalid", "unsupported-platform"], ["denied", "access-denied"]]) {
      execFileSync(executable, [mode, process.execPath, fileURLToPath(import.meta.url), code], {
        stdio: "pipe", env: { ...process.env, PROC_SAFE_NATIVE: "require" }, timeout: 10000,
      });
    }
    console.log("reaper capability errors verified on main and Worker");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
