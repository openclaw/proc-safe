import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { readProcessCommand } from "../dist/inspect.js";

// launchd is a live, protected process. Its denied arguments must not look absent.
assert.equal(process.platform, "darwin");
assert.throws(() => readProcessCommand(1), error => error.code === "access-denied");
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  const exited = once(worker, "exit");
  assert.deepEqual(await once(worker, "message"), ["verified"]);
  assert.deepEqual(await exited, [0]);
  console.log("Darwin command denial verified on main and Worker");
} else { parentPort.postMessage("verified"); }
