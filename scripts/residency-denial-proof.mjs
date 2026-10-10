import assert from "node:assert/strict";
import { accessSync, closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { once } from "node:events";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { samplePageCacheResidency } from "../dist/diagnostics.js";

process.env.PROC_SAFE_NATIVE = "require";
const file = isMainThread ? process.argv[2] : workerData;
const fd = openSync(file, "r");
try {
  assert.notEqual(fstatSync(fd).uid, process.getuid());
  assert.equal(readSync(fd, Buffer.alloc(1), 0, 1, 0), 1, "file must be readable");
  assert.throws(() => accessSync(file, constants.W_OK), { code: "EACCES" });
  assert.throws(() => samplePageCacheResidency(fd, { maxPages: 1 }), { code: "access-denied" });
} finally { closeSync(fd); }
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url), { workerData: file });
  const exit = once(worker, "exit");
  assert.deepEqual(await once(worker, "message"), ["denied"]);
  assert.deepEqual(await exit, [0]);
  console.log("readable foreign-file residency denied on main and Worker");
} else { parentPort.postMessage("denied"); }
