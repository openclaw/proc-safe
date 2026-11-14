import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { constants, tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { readProcessIdentity } from "../dist/identity.js";

function prove(probe) {
  for (const pid of [1, process.pid]) {
    const { procInfoError, ...expected } = JSON.parse(execFileSync(probe, [String(pid)], { encoding: "utf8" }));
    if (pid === 1 && process.getuid() !== 0) {
      assert.ok([constants.errno.EPERM, constants.errno.EACCES].includes(procInfoError), "launchd must exercise libproc denial");
    }
    assert.deepEqual(readProcessIdentity(pid), { ...expected, startTimeResolutionMicros: 1, exited: false });
  }
}

if (isMainThread) {
  assert.equal(process.platform, "darwin");
  const directory = mkdtempSync(join(tmpdir(), "proc-safe-kernel-identity-"));
  try {
    const probe = join(directory, "probe");
    execFileSync("cc", [fileURLToPath(new URL("../test/fixtures/darwin-kernel-identity.c", import.meta.url)), "-o", probe]);
    prove(probe);
    const worker = new Worker(new URL(import.meta.url), { workerData: probe });
    const exited = once(worker, "exit");
    assert.deepEqual(await once(worker, "message"), ["verified"]);
    assert.deepEqual(await exited, [0]);
    console.log("protected Darwin kernel identities verified on main and Worker");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
} else {
  prove(workerData);
  parentPort.postMessage("verified");
}
