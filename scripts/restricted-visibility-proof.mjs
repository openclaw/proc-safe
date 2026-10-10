import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { ProcSafeError } from "../dist/errors.js";
import { readProcessAncestry, readProcessIdentity } from "../dist/identity.js";

const pid = isMainThread ? Number(process.argv[2]) : workerData.pid;
assert.ok(Number.isInteger(pid) && pid > 0 && pid !== process.pid);
assert.throws(() => readProcessIdentity(pid), error => error instanceof ProcSafeError
  && error.code === "access-denied" && error.details?.reason === "visibility-policy");
assert.equal(readProcessIdentity(process.pid)?.pid, process.pid);
assert.throws(() => readProcessAncestry(pid), error => error instanceof ProcSafeError
  && error.code === "access-denied" && error.details?.reason === "visibility-policy");
const ancestry = readProcessAncestry(process.pid);
assert.equal(ancestry.chain[0].pid, process.pid);
assert.ok(ancestry.chain.every(identity => identity.pid > 1));
assert.equal(ancestry.complete, false);
assert.equal(ancestry.stoppedBy, "unreadable-parent");
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { pid } });
  const exit = once(worker, "exit");
  assert.deepEqual(await once(worker, "message"), ["verified"]);
  assert.deepEqual(await exit, [0]);
  await import("./runtime-proof.mjs");
  console.log(JSON.stringify({ proof: "restricted-visibility", platform: process.platform, passed: true }));
} else {
  parentPort.postMessage("verified");
}
