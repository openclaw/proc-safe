import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { listProcesses, readProcessCommand } from "../dist/inspect.js";

const rows = listProcesses({ timeoutMs: 5000, includeCommand: true });
assert.ok(rows.length > 0);
assert.ok(rows.every(row => row.owner === "unknown"));
const self = rows.find(row => row.pid === process.pid);
assert.ok(self?.identity);
assert.equal(self.identity.pid, process.pid);
assert.deepEqual(self.command, readProcessCommand(process.pid));
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  const exited = once(worker, "exit");
  assert.deepEqual(await once(worker, "message"), ["verified"]);
  assert.deepEqual(await exited, [0]);
  console.log("unreadable caller token preserves census on main and Worker");
} else { parentPort.postMessage("verified"); }
