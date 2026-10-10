import { parentPort, workerData } from "node:worker_threads";
import { readProcessIdentity, readProcessAncestry } from "../dist/identity.js";
import * as darwin from "../dist/darwin.js";
const pid = workerData?.pid ?? process.pid;
const identity = readProcessIdentity(pid);
if (readProcessAncestry(pid, { maxDepth: 1 })[0]?.pid !== pid) throw new Error("Worker ancestry failed");
parentPort.postMessage({ identity, coalition: process.platform === "darwin" ? darwin.readProcessCoalition(process.pid) : undefined });
