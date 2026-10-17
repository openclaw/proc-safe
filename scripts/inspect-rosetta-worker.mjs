import assert from "node:assert/strict";
import { parentPort } from "node:worker_threads";
import { listProcesses, readProcessCommand, isSupported } from "../dist/inspect.js";
assert.equal(isSupported(), false);
assert.throws(() => readProcessCommand(process.pid), error => error.code === "unsupported-platform" && /Rosetta/.test(error.message));
assert.ok(listProcesses({ timeoutMs: 5000 }).some(row => row.pid === process.pid && row.identity));
assert.throws(() => listProcesses({ timeoutMs: 5000, includeCommand: true }), error => error.code === "unsupported-platform" && /Rosetta/.test(error.message));
parentPort.postMessage("verified");
