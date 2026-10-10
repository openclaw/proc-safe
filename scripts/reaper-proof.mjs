import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { becomeChildSubreaper, inspectChildWaitState, isChildSubreaper, isSupported, reapChild } from "../dist/reaper.js";
import { readProcessIdentity } from "../dist/identity.js";

assert.equal(process.versions.bun, undefined, "this is the Node/libuv reaper proof");
const pause = new Int32Array(new SharedArrayBuffer(4));
const notChild = { code: "operation-failed", details: { reason: "not-a-child" } };

function waitExited(pid) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const state = inspectChildWaitState(pid);
    if (state.kind === "exited") return state;
    assert.equal(state.kind, "running", "an owned child must not disappear before reaping");
    Atomics.wait(pause, 0, 0, 1);
  }
  assert.fail("child did not exit within the proof deadline");
}

function assertNoChildren() {
  assert.deepEqual(inspectChildWaitState(), { kind: "none" });
  for (const tid of readdirSync("/proc/self/task")) {
    try { assert.equal(readFileSync(`/proc/self/task/${tid}/children`, "utf8").trim(), ""); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

async function proveChild(pid, fifo, expected, directory) {
  const fd = openSync(fifo, "w");
  let unrelated;
  let unrelatedClosed;
  try {
    assert.equal(readProcessIdentity(pid).parentPid, process.pid);
    assert.deepEqual(inspectChildWaitState(pid), { kind: "running" });
    assert.deepEqual(inspectChildWaitState(), { kind: "running" });
    assert.equal(reapChild(pid), null);
    assert.deepEqual(inspectChildWaitState(process.pid), { kind: "none" });
    assert.throws(() => reapChild(process.pid), notChild);

    const marker = join(directory, "exit-node");
    unrelated = spawn(process.execPath, ["-e", `
      const fs = require('node:fs');
      const timer = setInterval(() => {
        if (fs.existsSync(process.argv[1])) { clearInterval(timer); process.exit(37); }
      }, 1);
      process.stdout.write('ready');
    `, marker], { stdio: ["ignore", "pipe", "inherit"] });
    unrelatedClosed = once(unrelated, "close");
    const unrelatedExit = once(unrelated, "exit");
    await once(unrelated.stdout, "data");
    assert.deepEqual(inspectChildWaitState(unrelated.pid), { kind: "running" });

    writeSync(fd, "e");
    const exited = waitExited(pid);
    assert.deepEqual(exited, { kind: "exited", pid });
    assert.equal(Object.isFrozen(exited), true);
    // Repeated WNOWAIT observations leave the zombie and its exit status intact.
    for (let count = 0; count < 5; count++) {
      assert.deepEqual(inspectChildWaitState(pid), exited);
      assert.deepEqual(inspectChildWaitState(), exited);
      assert.equal(readProcessIdentity(pid).exited, true);
    }
    writeFileSync(marker, "exit");
    let reaped = false;
    const deadline = performance.now() + 5000;
    let observedNodeExit = false;
    while (performance.now() < deadline) {
      const next = inspectChildWaitState();
      // Only this fixture PID belongs to the native reaper. Never reap the
      // Node child, even if P_ALL happens to return it before libuv runs.
      if (!reaped && inspectChildWaitState(pid).kind === "exited") {
        const result = reapChild(pid);
        assert.deepEqual(result, { pid, ...expected });
        assert.equal(Object.isFrozen(result), true);
        reaped = true;
      }
      const nodeState = inspectChildWaitState(unrelated.pid);
      if (nodeState.kind !== "running") { observedNodeExit = true; break; }
      assert.notEqual(next.kind, "none", "a live child precludes extinction");
      Atomics.wait(pause, 0, 0, 1);
    }
    assert.equal(reaped, true);
    assert.equal(observedNodeExit, true);
    assert.deepEqual(inspectChildWaitState(pid), { kind: "none" });
    assert.throws(() => reapChild(pid), notChild);
    assert.deepEqual(await unrelatedExit, [37, null], "libuv must retain the Node child's exit status");
    assert.deepEqual(await unrelatedClosed, [37, null]);
    assertNoChildren();
  } finally {
    closeSync(fd);
    if (unrelated && unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill("SIGKILL");
    if (unrelatedClosed) await unrelatedClosed;
    const state = inspectChildWaitState(pid);
    if (state.kind === "running") process.kill(pid, "SIGKILL");
    if (state.kind !== "none") { waitExited(pid); reapChild(pid); }
  }
}

async function proveAll({ fixture, wallPid, wallFifo }) {
  assert.equal(isSupported(), true);
  assert.equal(isChildSubreaper(), false);
  becomeChildSubreaper();
  becomeChildSubreaper();
  assert.equal(isChildSubreaper(), true);
  const directory = mkdtempSync(join(tmpdir(), "proc-safe-reaper-owner-"));
  try {
    await proveChild(wallPid, wallFifo, { exitCode: 42, signal: null }, directory);
    for (const mode of ["exit", "signal"]) {
      const subdirectory = join(directory, mode);
      // A separate directory gives each libuv child an untouched exit marker.
      const { mkdirSync } = await import("node:fs");
      mkdirSync(subdirectory);
      const fifo = join(subdirectory, "gate");
      const root = spawn(fixture, [fifo, mode], { stdio: ["ignore", "pipe", "inherit"] });
      const rootClosed = once(root, "close");
      let text = "";
      root.stdout.on("data", chunk => { text += chunk; });
      assert.deepEqual(await rootClosed, [0, null]);
      const pid = Number(text.trim());
      assert.ok(Number.isInteger(pid) && pid > 0);
      await proveChild(pid, fifo, mode === "signal"
        ? { exitCode: null, signal: "SIGTERM" } : { exitCode: 23, signal: null }, subdirectory);
    }
    assertNoChildren();
    return { scenarios: 3 };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (!isMainThread) {
  parentPort.postMessage(await proveAll(workerData));
} else if (["owner", "worker"].includes(process.argv[2])) {
  const input = { fixture: process.argv[3], wallPid: Number(process.argv[4]), wallFifo: process.argv[5] };
  if (process.argv[2] === "owner") console.log(JSON.stringify(await proveAll(input)));
  else {
    assert.equal(isChildSubreaper(), false);
    const worker = new Worker(new URL(import.meta.url), { workerData: input });
    const finished = once(worker, "exit");
    const [result] = await once(worker, "message");
    assert.deepEqual(await finished, [0]);
    assert.equal(isChildSubreaper(), true, "Worker subreaper setting is process-wide");
    assertNoChildren();
    console.log(JSON.stringify(result));
  }
} else {
  assert.equal(process.platform, "linux");
  const directory = mkdtempSync(join(tmpdir(), "proc-safe-reaper-"));
  try {
    const fixture = join(directory, "fixture");
    execFileSync("cc", [fileURLToPath(new URL("../test/fixtures/linux-reaper.c", import.meta.url)), "-o", fixture]);
    for (const context of ["owner", "worker"]) {
      const result = execFileSync(fixture, ["--launch", join(directory, `${context}.fifo`),
        process.execPath, fileURLToPath(new URL(import.meta.url)), context, fixture],
      { encoding: "utf8", timeout: 10000 });
      assert.deepEqual(JSON.parse(result), { scenarios: 3 });
    }
    console.log(JSON.stringify({ platform: process.platform, arch: process.arch, contexts: 2, scenarios: 6 }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
