import assert from "node:assert/strict";
import { parentPort } from "node:worker_threads";
import { readProcessCommand, isSupported } from "../dist/inspect.js";
assert.equal(isSupported(), false);
assert.throws(() => readProcessCommand(process.pid), error => error.code === "unsupported-platform" && /Rosetta/.test(error.message));
parentPort.postMessage("verified");
