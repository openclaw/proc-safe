import { parentPort } from "node:worker_threads";
import { readProcessIdentity, readProcessAncestry } from "../dist/identity.js";
import * as darwin from "../dist/darwin.js";
const identity = readProcessIdentity(process.pid);
if (readProcessAncestry(process.pid, { maxDepth: 1 })[0]?.pid !== process.pid) throw new Error("Worker ancestry failed");
parentPort.postMessage({ identity, coalition: process.platform === "darwin" ? darwin.readProcessCoalition(process.pid) : undefined });
