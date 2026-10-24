import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { listProcesses } from "../dist/inspect.js";
import { readProcessIdentity } from "../dist/identity.js";
import { hostNativeTarget } from "./native-targets.mjs";

function observe({ pid, parentPid, state }) {
  assert.notEqual(process.geteuid(), 0, "foreign-owner proof needs a non-root observer");
  const rows = listProcesses({ timeoutMs: 5000 });
  assert.equal(new Set(rows.map(row => row.pid)).size, rows.length);
  assert.ok(rows.every(row => row.pid > 0 && row.command === undefined));
  const root = rows.find(row => row.pid === 1);
  assert.equal(root.owner, "different");
  assert.equal(root.parentPid, 0);
  assert.equal(root.processGroupId, 1);
  assert.equal(root.identity, undefined);
  assert.ok(root.state);
  const selected = listProcesses({ timeoutMs: 5000, pids: [pid, pid] });
  if (state === "gone") {
    assert.equal(readProcessIdentity(pid), null);
    assert.deepEqual(selected, []);
  } else {
    assert.equal(selected.length, 1);
    const row = selected[0];
    assert.equal(row.pid, pid);
    assert.equal(row.parentPid, parentPid);
    assert.equal(row.processGroupId, pid, "setsid child must lead its own group");
    assert.equal(row.owner, "same");
    assert.equal(row.state, state);
    assert.equal(Object.isFrozen(row), true);
    assert.equal(row.identity.parentPid, parentPid);
    assert.equal(row.identity.exited, state === "zombie");
    assert.equal(Object.isFrozen(row.identity), true);
    const withCommand = listProcesses({ timeoutMs: 5000, includeCommand: true, pids: [pid] })[0];
    if (state !== "zombie") {
      assert.ok(withCommand.command.executable.endsWith("census-child"));
      assert.deepEqual(withCommand.command.environment, {});
      assert.equal(Object.isFrozen(withCommand.command), true);
    } else {
      assert.equal(withCommand.command, undefined);
    }
  }
  assert.deepEqual(listProcesses({ timeoutMs: 5000, pids: [] }), []);
  const selectedRoot = listProcesses({ timeoutMs: 5000, includeCommand: true, pids: [1] });
  assert.equal(selectedRoot.length, 1);
  assert.equal(selectedRoot[0].owner, "different");
  assert.equal(selectedRoot[0].identity, undefined);
  assert.equal(selectedRoot[0].command, undefined);
  assert.throws(() => listProcesses({ timeoutMs: Number.MIN_VALUE }), error => error.code === "timeout");
  const native = createRequire(import.meta.url)(hostNativeTarget().package);
  assert.throws(() => native.listProcesses(Number.MIN_VALUE, false), /timeout:/);
}

async function proveBoth(observation) {
  observe(observation);
  const worker = new Worker(new URL(import.meta.url), { workerData: observation });
  const exited = once(worker, "exit");
  assert.deepEqual(await once(worker, "message"), ["verified"]);
  assert.deepEqual(await exited, [0]);
}

async function proveExiting(child, lines, pid) {
  const selected = listProcesses({ timeoutMs: 5000, pids: [pid] });
  const identity = readProcessIdentity(pid);
  const fullRow = listProcesses({ timeoutMs: 5000 }).find(row => row.pid === pid);
  // Recheck after both censuses so a sample that outlives the exit window cannot pass.
  child.stdin.write("q");
  const window = JSON.parse((await lines.next()).value);
  const evidence = { selected, identity, fullRow, window };
  try {
    assert.equal(window.stillExiting, true, "censuses must finish inside the exit window");
    assert.equal(window.libprocResult, 0);
    assert.equal(window.libprocErrno, 3); // Darwin ESRCH.
    assert.equal(window.state, 2); // XNU reports SRUN while the last pty close drains.
    assert.notEqual(window.flags & 0x2000, 0); // P_WEXIT.
    assert.ok(identity);
    assert.equal(identity.parentPid, child.pid);
    assert.equal(identity.exited, false);
    assert.equal(selected.length, 1);
    for (const row of [selected[0], fullRow]) {
      assert.ok(row, "exiting child must remain in selected and full censuses");
      assert.equal(row.pid, pid);
      assert.equal(row.parentPid, child.pid, "exiting row must retain its parent PID");
      assert.equal(row.processGroupId, pid);
      assert.equal(row.owner, "same");
      assert.equal(row.state, "running");
      assert.ok(row.identity);
      assert.equal(row.identity.parentPid, child.pid);
      assert.equal(row.identity.exited, false);
      assert.equal(Object.isFrozen(row), true);
      assert.equal(Object.isFrozen(row.identity), true);
    }
  } catch (error) {
    console.error("Exiting census evidence:", JSON.stringify(evidence));
    throw error;
  }
  return window;
}

if (!isMainThread) {
  observe(workerData);
  parentPort.postMessage("verified");
} else {
  assert.equal(process.platform, "darwin");
  const directory = process.argv[2] ? undefined : mkdtempSync(join(tmpdir(), "proc-safe-census-"));
  let child;
  let closed;
  try {
    const executable = process.argv[2] ?? join(directory, "census-child");
    if (directory) execFileSync("cc", [fileURLToPath(new URL("../test/fixtures/darwin-census.c", import.meta.url)), "-o", executable]);
    child = spawn(executable, [], { stdio: ["pipe", "pipe", "inherit"] });
    closed = once(child, "close");
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const pid = Number((await lines.next()).value);
    assert.ok(Number.isInteger(pid) && pid > 0);
    // BSD process status stays runnable while this process's thread waits on a pipe.
    await proveBoth({ pid, parentPid: child.pid, state: "running" });
    child.stdin.write("s");
    assert.equal((await lines.next()).value, "stopped");
    await proveBoth({ pid, parentPid: child.pid, state: "stopped" });
    child.stdin.write("e");
    assert.equal((await lines.next()).value, "exiting");
    const exiting = await proveExiting(child, lines, pid);
    child.stdin.write("z");
    assert.equal((await lines.next()).value, "zombie");
    const timing = JSON.parse((await lines.next()).value);
    await proveBoth({ pid, parentPid: child.pid, state: "zombie" });
    child.stdin.end("r");
    assert.deepEqual(await closed, [0, null]);
    await proveBoth({ pid, parentPid: child.pid, state: "gone" });
    console.log(JSON.stringify({ platform: process.platform, arch: process.arch, passed: 9, exiting: { ...exiting, ...timing } }));
  } finally {
    if (child && child.exitCode === null) {
      child.stdin.end();
      await closed;
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
