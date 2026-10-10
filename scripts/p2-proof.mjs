import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import * as diagnostics from "../dist/diagnostics.js";
import * as fixtures from "../dist/test-support.js";
import { readProcessIdentity } from "../dist/identity.js";

const self = new URL(import.meta.url);

function residency() {
  const directory = mkdtempSync(join(tmpdir(), "proc-safe-residency-"));
  const fd = openSync(join(directory, "pages"), "wx+");
  try {
    const empty = diagnostics.samplePageCacheResidency(fd, { maxPages: 8 });
    assert.equal(empty.sampledPages, 0);
    assert.equal(empty.residentPages, 0);
    assert.ok(Number.isInteger(empty.pageSize) && empty.pageSize > 0);
    assert.ok(Object.isFrozen(empty));
    // A new sparse file is our cold candidate; cache state remains advisory.
    ftruncateSync(fd, empty.pageSize * 64 + 1);
    const cold = diagnostics.samplePageCacheResidency(fd, { maxPages: 8 });
    const buffer = Buffer.alloc(empty.pageSize);
    for (let page = 0; page < 65; page++) readSync(fd, buffer, 0, buffer.length, page * empty.pageSize);
    const touched = diagnostics.samplePageCacheResidency(fd, { maxPages: 8 });
    for (const sample of [cold, touched]) {
      assert.equal(sample.pageSize, empty.pageSize);
      assert.equal(sample.sampledPages, 8);
      assert.ok(Number.isInteger(sample.residentPages));
      assert.ok(sample.residentPages >= 0 && sample.residentPages <= sample.sampledPages);
    }
    assert.equal(diagnostics.samplePageCacheResidency(fd, { maxPages: 100 }).sampledPages, 65);
    assert.equal(diagnostics.samplePageCacheResidency(fd, { maxPages: 1 }).sampledPages, 1);
    assert.equal(diagnostics.samplePageCacheResidency(fd, { maxPages: Number.MAX_SAFE_INTEGER }).sampledPages, 65);
    return { cold, touched };
  } finally { closeSync(fd); rmSync(directory, { recursive: true, force: true }); }
}

function seccomp() {
  fixtures.installKillGroupSeccompFilter();
  assert.throws(() => process.kill(0, 0), { code: "EPERM" });
  assert.throws(() => process.kill(-2147483647, 0), { code: "EPERM" });
  assert.equal(process.kill(process.pid, 0), true);
  return "seccomp-denies-groups";
}

async function detached() {
  const directory = mkdtempSync(join(tmpdir(), "proc-safe-detached-"));
  const script = join(directory, "child fixture.mjs");
  const output = join(directory, "receipt.json");
  const args = ["", "two words", 'a"quote', "tail\\", 'two\\\\"quotes', "café"];
  writeFileSync(script, `import { writeFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { hasConsoleWindow } from ${JSON.stringify(new URL("../dist/test-support.js", import.meta.url).href)};
    const cwd = process.cwd();
    // Release the directory handle before publishing the receipt: Windows may
    // expose exit metadata before all process-owned handles finish closing.
    process.chdir(tmpdir());
    writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, args: process.argv.slice(3),
      cwd, console: hasConsoleWindow() }));`);
  let pid;
  try {
    const child = fixtures.spawnRawWithoutConsole({ executable: process.execPath, args: [script, output, ...args], cwd: directory });
    pid = child.pid;
    assert.ok(Object.isFrozen(child));
    assert.ok(Number.isInteger(pid) && pid > 0);
    const deadline = Date.now() + 5000;
    let receipt;
    while (Date.now() < deadline) {
      try { receipt = JSON.parse(readFileSync(output, "utf8")); break; }
      catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      await delay(10);
    }
    assert.ok(receipt, "detached child must write a receipt");
    assert.equal(receipt.pid, pid);
    assert.deepEqual(receipt.args, args);
    assert.equal(receipt.cwd.toLowerCase(), directory.toLowerCase());
    assert.equal(receipt.console, false);
    assert.equal(typeof fixtures.hasConsoleWindow(), "boolean");
    return "detached-console-free";
  } finally {
    if (pid) {
      const deadline = Date.now() + 5000;
      let running = true;
      while (Date.now() < deadline) {
        const identity = readProcessIdentity(pid);
        if (!identity || identity.exited) { running = false; break; }
        await delay(10);
      }
      assert.equal(running, false, "fixture must terminate before removing its working directory");
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

async function inWorker(mode) {
  const worker = new Worker(self, { workerData: mode });
  const ended = once(worker, "exit");
  const [result] = await once(worker, "message");
  assert.deepEqual(await ended, [0]);
  return result;
}

if (!isMainThread) {
  parentPort.postMessage(workerData === "residency" ? residency()
    : workerData === "seccomp" ? seccomp() : await detached());
} else if (process.argv[2] === "seccomp") {
  seccomp();
} else if (process.argv[2] === "seccomp-worker") {
  assert.equal(await inWorker("seccomp"), "seccomp-denies-groups");
  // A Worker filter affects the calling thread; it must not contaminate its parent.
  assert.equal(process.kill(0, 0), true);
} else {
  let passed = 0;
  if (process.platform === "linux") {
    assert.equal(diagnostics.isSupported(), true);
    assert.equal(fixtures.isSupported(), true);
    const main = residency();
    const worker = await inWorker("residency");
    assert.equal(main.cold.pageSize, worker.cold.pageSize);
    passed += 2;
    for (const mode of ["seccomp", "seccomp-worker"]) {
      execFileSync(process.execPath, [fileURLToPath(self), mode], { stdio: "pipe", timeout: 10000 });
      assert.equal(process.kill(0, 0), true, "seccomp must stay in the disposable fixture");
      passed++;
    }
    const fd = openSync(fileURLToPath(self), "r");
    closeSync(fd);
    assert.throws(() => diagnostics.samplePageCacheResidency(fd, { maxPages: 1 }), { code: "operation-failed" });
    const directoryFd = openSync(tmpdir(), "r");
    try { assert.throws(() => diagnostics.samplePageCacheResidency(directoryFd, { maxPages: 1 }), { code: "invalid-argument" }); }
    finally { closeSync(directoryFd); }
    passed++;
  } else {
    assert.equal(diagnostics.isSupported(), false);
    assert.throws(() => diagnostics.samplePageCacheResidency(0, { maxPages: 1 }), { code: "unsupported-platform" });
    assert.throws(() => fixtures.installKillGroupSeccompFilter(), { code: "unsupported-platform" });
    passed++;
  }
  if (process.platform === "win32") {
    assert.equal(fixtures.isSupported(), true);
    await detached();
    assert.equal(await inWorker("detached"), "detached-console-free");
    assert.throws(() => fixtures.spawnRawWithoutConsole({ executable: "Z:\\proc-safe-missing\\child.exe" }), { code: "operation-failed" });
    passed += 3;
  } else {
    assert.throws(() => fixtures.spawnRawWithoutConsole({ executable: "missing" }), { code: "unsupported-platform" });
    assert.throws(() => fixtures.hasConsoleWindow(), { code: "unsupported-platform" });
    if (process.platform !== "linux") assert.equal(fixtures.isSupported(), false);
    passed++;
  }
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, runtime: process.versions.bun ? "bun" : "node", passed }));
}
