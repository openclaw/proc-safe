import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { PinnedProcess } from "../dist/windows-job.js";
import { installPinTestBinding } from "./windows-pin-test-binding.mjs";

const { inspectPinAccess } = installPinTestBinding();
const directory = isMainThread ? process.argv[2] : workerData.directory;
const fixture = resolve(`target/${process.arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc/release/proc-safe-job-fixture.exe`);
const pid = Number(readFileSync(join(directory, "pid"), "utf8"));
// Initialize Node/Bun, native registration and each Worker's CSPRNG before target denial.
randomBytes(1);
const self = PinnedProcess.open(process.pid);
assert.ok(self);
if (inspectPinAccess) assert.equal(inspectPinAccess(), 0x1000);
self.close();
const token = JSON.parse(execFileSync(fixture, ["token-info", String(process.pid)], { encoding: "utf8" }));
console.log(JSON.stringify({ pinDenialRestrictedCaller: { thread: isMainThread ? "main" : "worker", ...token } }));
assert.equal(token.debug.enabled, false);
assert.equal(token.impersonate.enabled, false);
assert.equal(token.admin.enabled, false);
if (token.admin.present) assert.equal(token.admin.denyOnly, true);
let observer;
async function waitFor(name) {
  while (!existsSync(join(directory, name))) {
    assert.equal(existsSync(join(directory, "abort")), false, "denial proof aborted");
    await setTimeout(5);
  }
}
function verify() {
  observer = PinnedProcess.open(pid);
  assert.ok(observer);
  assert.equal(observer.access, "observe");
  assert.equal(observer.identity.exited, false);
  assert.ok(observer.imagePath.endsWith("proc-safe-job-fixture.exe"));
  if (inspectPinAccess) assert.equal(inspectPinAccess(), 0x1000);
  assert.throws(() => PinnedProcess.open(pid, { access: "lifetime-owner" }), e => e.code === "access-denied");
}
function exited() {
  assert.equal(observer.identity.exited, true);
  observer.close();
}
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { directory } });
  const workerExit = once(worker, "exit");
  try {
    assert.deepEqual(await once(worker, "message"), ["ready"]);
    writeFileSync(join(directory, "ready"), "ready");
    await waitFor("go");
    verify();
    worker.postMessage("go");
    assert.deepEqual(await once(worker, "message"), ["verified"]);
    writeFileSync(join(directory, "verified"), "verified");
    await waitFor("released");
    exited();
    worker.postMessage("released");
    assert.deepEqual(await workerExit, [0]);
  } finally { observer?.close(); await worker.terminate(); }
} else {
  try {
    parentPort.postMessage("ready");
    assert.deepEqual(await once(parentPort, "message"), ["go"]);
    verify();
    parentPort.postMessage("verified");
    assert.deepEqual(await once(parentPort, "message"), ["released"]);
    exited();
  } finally { observer?.close(); }
}
