import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { readProcessAncestry } from "../dist/identity.js";

const ancestry = readProcessAncestry(process.pid);
assert.equal(ancestry.chain[0].pid, process.pid);
assert.ok(ancestry.chain.every(identity => identity.pid > 1));
assert.equal(ancestry.complete, false);
assert.equal(ancestry.stoppedBy, "unreadable-parent");
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  const exited = once(worker, "exit");
  assert.deepEqual(await once(worker, "message"), ["verified"]);
  assert.deepEqual(await exited, [0]);
  console.log("unreadable parent preserves ancestry on main and Worker");
} else {
  parentPort.postMessage("verified");
}
