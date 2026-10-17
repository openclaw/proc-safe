import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { listProcesses, readProcessCommand } from "../dist/inspect.js";

// Node and each Worker must initialize their CSPRNG before token access is denied.
randomBytes(1);
assert.ok(readProcessCommand(process.pid));
const before = listProcesses({ timeoutMs: 5000 });
assert.equal(before.find(row => row.pid === process.pid)?.owner, "same");
function verify() {
  const rows = listProcesses({ timeoutMs: 5000, includeCommand: true });
  assert.ok(rows.length > 0);
  assert.ok(rows.every(row => row.owner === "unknown"));
  const self = rows.find(row => row.pid === process.pid);
  assert.ok(self?.identity);
  assert.equal(self.identity.pid, process.pid);
  assert.deepEqual(self.command, readProcessCommand(process.pid));
  const selected = listProcesses({ timeoutMs: 5000, includeCommand: true, pids: [process.pid] });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].owner, "unknown");
  assert.deepEqual(selected[0].identity, self.identity);
  assert.deepEqual(selected[0].command, self.command);
}
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  const exited = once(worker, "exit");
  assert.deepEqual(await once(worker, "message"), ["ready"]);
  const directory = process.argv[2];
  writeFileSync(join(directory, "ready"), "ready");
  while (!existsSync(join(directory, "go"))) await setTimeout(10);
  verify();
  worker.postMessage("go");
  assert.deepEqual(await once(worker, "message"), ["verified"]);
  assert.deepEqual(await exited, [0]);
  console.log("unreadable caller token preserves census on main and Worker");
} else {
  parentPort.postMessage("ready");
  assert.deepEqual(await once(parentPort, "message"), ["go"]);
  verify();
  parentPort.postMessage("verified");
}
