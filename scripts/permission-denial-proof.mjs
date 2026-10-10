import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { ProcSafeError } from "../dist/errors.js";
import { readProcessIdentity } from "../dist/identity.js";
import { readProcessCommand, listProcesses } from "../dist/inspect.js";

function assertDenied(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.throws(() => readProcessIdentity(pid), error => error instanceof ProcSafeError && error.code === "access-denied");
  if (process.platform === "win32") {
    assert.throws(() => readProcessCommand(pid), error => error instanceof ProcSafeError && error.code === "access-denied");
    const rows = listProcesses({ timeoutMs: 5000, includeCommand: true });
    assert.deepEqual(rows.find(row => row.pid === pid), { pid, owner: "unknown" });
  }
}

export async function provePermissionDenied(pid) {
  assertDenied(pid);
  const worker = new Worker(new URL(import.meta.url), { workerData: { pid } });
  const exit = once(worker, "exit");
  assert.deepEqual(await once(worker, "message"), ["verified"]);
  assert.deepEqual(await exit, [0]);
}

if (!isMainThread) {
  assertDenied(workerData.pid);
  parentPort.postMessage("verified");
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await provePermissionDenied(Number(process.argv[2]));
  console.log("permission denial verified on main and Worker");
}
