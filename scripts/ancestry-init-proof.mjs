import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { readProcessAncestry } from "../dist/identity.js";
import { ProcSafeError } from "../dist/errors.js";

// Run in fresh isolates so even the first native load would be observable.
process.env.PROC_SAFE_NATIVE = "require";
let nativeLoads = 0;
process.dlopen = () => {
  nativeLoads++;
  throw new Error("init-process rejection must precede native loading");
};
for (const pid of [-1, 0, 1]) {
  assert.throws(() => readProcessAncestry(pid), error => error instanceof ProcSafeError
    && error.code === "invalid-argument" && error.details?.reason === "init-process");
}
assert.equal(nativeLoads, 0);
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  const exited = once(worker, "exit");
  assert.deepEqual(await once(worker, "message"), ["verified"]);
  assert.deepEqual(await exited, [0]);
  console.log("init-process rejection precedes native loading on main and Worker");
} else {
  parentPort.postMessage("verified");
}
