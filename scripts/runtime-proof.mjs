import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { readProcessIdentity, readProcessAncestry, isSupported } from "../dist/identity.js";
import * as darwin from "../dist/darwin.js";
import { proveZombie } from "./zombie-proof.mjs";
import { assertSameIdentity, readAfterClose } from "./identity-proof-assertions.mjs";
import { proveLinuxEpoch } from "./linux-epoch-proof.mjs";
import { proveRetainedExit } from "./windows-exit-proof.mjs";

assert.equal(isSupported(), true, "this runtime lane requires working native identity");
const self = readProcessIdentity(process.pid);
assert.equal(self.pid, process.pid);
assert.equal(self.parentPid, process.ppid);
assert.equal(self.exited, false);
if (["linux", "freebsd"].includes(process.platform)) {
  assert.ok(Number.isSafeInteger(self.startTimeSinceBootMicros));
  assert.ok(self.startTimeSinceBootMicros >= 0);
} else {
  assert.equal(Object.hasOwn(self, "startTimeSinceBootMicros"), false);
}
assert.ok(Number.isSafeInteger(self.startTimeMicros));
assert.ok(self.startTimeMicros > Date.UTC(2020, 0, 1) * 1000);
assert.ok(self.startTimeMicros <= Date.now() * 1000);
assert.ok(self.startTimeResolutionMicros > 0);
assertSameIdentity(readProcessIdentity(process.pid), self);
assert.equal(readProcessAncestry(process.pid, { maxDepth: 1 }).length, 1);
// The default walk never reads PID 0/1. With ordinary visibility it must complete; under the
// restricted-visibility harness a hidden (root-owned) parent is unknown, so it throws instead.
try {
  const fullAncestry = readProcessAncestry(process.pid);
  assert.ok(fullAncestry.length >= 1);
  assert.equal(fullAncestry[0].pid, process.pid);
  assert.ok(fullAncestry.every(identity => identity.pid > 1));
} catch (error) {
  if (process.env.PROC_SAFE_TEST_RESTRICTED !== "1") throw error;
  assert.equal(error?.code, "access-denied");
  assert.equal(error?.details?.reason, "visibility-policy");
}

const earliest = Date.now() * 1000;
let childIdentity;
const child = spawn(process.execPath, ["-e", "process.title = 'proc) test (name'; console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "inherit"] });
try {
  await once(child.stdout, "data");
  const latest = Date.now() * 1000;
  const identity = readProcessIdentity(child.pid);
  childIdentity = identity;
  assert.equal(identity.exited, false);
  assert.equal(identity.pid, child.pid);
  assert.equal(identity.parentPid, process.pid);
  // Linux: one birth tick + one bounded clock-sampling tick; Date.now loses 1 ms.
  const epochTolerance = process.platform === "linux" ? 2 * identity.startTimeResolutionMicros + 1000 : 1000;
  assert.ok(identity.startTimeMicros >= earliest - epochTolerance);
  assert.ok(identity.startTimeMicros <= latest + epochTolerance);
  const ancestry = readProcessAncestry(child.pid, { maxDepth: 2 });
  assert.deepEqual(ancestry.map(p => p.pid), [child.pid, process.pid]);
  assert.ok(ancestry[1].startTimeMicros <= ancestry[0].startTimeMicros);
} finally {
  // exit announces termination; close also releases Node's retained handles.
  const closed = once(child, "close");
  child.kill();
  await closed;
}
if (process.platform === "linux") {
  const dir = mkdtempSync(join(tmpdir(), "proc-safe-name-"));
  let raw;
  try {
    const executable = join(dir, "raw-name");
    execFileSync("cc", [new URL("../test/fixtures/linux-process-name.c", import.meta.url).pathname, "-o", executable]);
    raw = spawn(executable, [], { stdio: ["ignore", "pipe", "inherit"] });
    await once(raw.stdout, "data");
    const identity = readProcessIdentity(raw.pid);
    assert.equal(identity.pid, raw.pid);
    assert.equal(identity.parentPid, process.pid);
    assert.ok(identity.startTimeMicros > self.startTimeMicros);
  } finally {
    if (raw) {
      const closed = once(raw, "close");
      raw.kill();
      await closed;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
const remaining = readAfterClose(child.pid, childIdentity);
if (remaining.restricted) {
  assert.throws(() => readProcessAncestry(child.pid, { maxDepth: 1 }), error =>
    error.code === "access-denied" && error.details?.reason === "visibility-policy");
} else {
  assert.deepEqual(readProcessAncestry(child.pid, { maxDepth: 1 }), remaining.result ? [remaining.result] : []);
}
if (process.platform !== "win32") await proveZombie();
else await proveRetainedExit();

const worker = new Worker(new URL("./worker-proof.mjs", import.meta.url));
const workerExit = once(worker, "exit");
const [result] = await once(worker, "message");
assertSameIdentity(result.identity, self);
if (process.platform === "darwin") {
  const coalition = darwin.readProcessCoalition(process.pid);
  assert.ok(coalition === null || typeof coalition.id === "bigint" && coalition.id > 0n);
  assert.deepEqual(result.coalition, coalition);
  assert.equal(darwin.readProcessCoalition(child.pid), null);
} else {
  assert.equal(darwin.isSupported(), false);
  assert.throws(() => darwin.readProcessCoalition(process.pid), e => e.code === "unsupported-platform");
}
assert.deepEqual(await workerExit, [0]);
if (process.platform === "linux") {
  const directory = mkdtempSync(join(tmpdir(), "proc-safe-epoch-"));
  try {
    const executable = join(directory, "clock-probe");
    execFileSync("cc", [new URL("../test/fixtures/linux-epoch.c", import.meta.url).pathname, "-o", executable]);
    await proveLinuxEpoch(executable);
    const epochWorker = new Worker(new URL("./worker-proof.mjs", import.meta.url), { workerData: { epochExecutable: executable } });
    const exited = once(epochWorker, "exit");
    const [proof] = await once(epochWorker, "message");
    assert.equal(proof.epochSamples, 32);
    assert.deepEqual(await exited, [0]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ platform: process.platform, arch: process.arch, runtime: process.versions.bun ? "bun" : "node", passed: 7 }));
