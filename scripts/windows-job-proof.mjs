import assert from "node:assert/strict";
import { installPinTestBinding } from "./windows-pin-test-binding.mjs";
import { ProcSafeError } from "../dist/errors.js";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtempSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, threadId, SHARE_ENV } from "node:worker_threads";
import { WindowsJob, PinnedProcess, bindCurrentProcessLifetimeTo, retainCurrentProcessJobUntilExit, isCurrentProcessInJob, isSupported } from "../dist/windows-job.js";

const fixture = resolve(`target/${process.arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc/release/proc-safe-job-fixture.exe`);
const entry = fileURLToPath(import.meta.url);
const { injectAssignmentFailure, inspectPinAccess, openPinWithoutDebug, interceptNextInput } = installPinTestBinding();
const pause = () => new Promise(r => setTimeout(r, 5));
async function until(fn) {
  const deadline = performance.now() + 8000;
  while (performance.now() < deadline) { const value = fn(); if (value) return value; await pause(); }
  throw new Error("Windows job proof deadline expired");
}
function quote(s) { return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'; }
function launch(job, source, env) {
  return job.spawn({ executable: process.execPath, commandLine: [process.execPath, "-e", source].map(quote).join(" "), env });
}
async function drain(child) {
  let out = Buffer.alloc(0), err = Buffer.alloc(0), outEnd = false, errEnd = false, code;
  await until(() => {
    for (let i = 0; i < 4; i++) {
      if (!outEnd) { const bytes = child.readStdout(65536); if (bytes === null) outEnd = true; else out = Buffer.concat([out, bytes]); }
      if (!errEnd) { const bytes = child.readStderr(65536); if (bytes === null) errEnd = true; else err = Buffer.concat([err, bytes]); }
    }
    code = child.exitCode();
    return code !== null && outEnd && errEnd;
  });
  return { out, err, code };
}
function host(mode, worker = false, extra = []) {
  const args = [entry, mode, worker ? "worker" : "main", ...extra];
  const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let errors = "";
  child.stderr.on("data", b => errors += b);
  const exit = once(child, "exit");
  return { child, next: async () => { const line = await lines.next(); assert.equal(line.done, false, errors); return line.value; }, exit, errors: () => errors };
}

async function childMode(mode) {
  if (mode === "input-parent") {
    // Non-killing job isolates input-owner teardown from job kill-on-close.
    const job = WindowsJob.create({ killOnJobClose: false });
    const child = job.spawn({ executable: fixture, commandLine: [fixture, "stdin-eof", process.argv[4]].map(quote).join(" "), stdin: "pipe" });
    globalThis.inputOwners = { job, child }; // Keep both owners reachable until environment teardown.
    console.log(child.pid);
    if (!isMainThread) await once(parentPort, "message");
    // Deliberately do not close child: Worker teardown or OS exit must close its writer.
    if (isMainThread) setInterval(() => {}, 1000);
  } else if (mode === "nested-input") {
    const outer = WindowsJob.create();
    retainCurrentProcessJobUntilExit(outer);
    const inner = WindowsJob.create();
    const child = inner.spawn({ executable: fixture, commandLine: [fixture, "stdin-eof", process.argv[4]].map(quote).join(" "), stdin: "pipe" });
    assert.equal(child.writeStdin(Buffer.from("nested")), 6);
    child.closeStdin();
    assert.equal((await drain(child)).code, 0);
    assert.equal(readFileSync(process.argv[4], "utf8"), "6");
    child.close(); inner.close();
    console.log("nested-input");
  } else if (mode === "bind" || mode === "fail-bind") {
    const owner = PinnedProcess.open(Number(process.argv[4]), { access: "lifetime-owner" });
    assert.ok(owner);
    if (mode === "fail-bind") {
      const before = isCurrentProcessInJob();
      injectAssignmentFailure();
      assert.throws(() => bindCurrentProcessLifetimeTo(owner), e => e.code === "operation-failed" && e.message.includes("injected job assignment failure"));
      assert.equal(isCurrentProcessInJob(), before);
      owner.close();
      console.log("rolled-back");
      return;
    }
    try {
      bindCurrentProcessLifetimeTo(owner);
      owner.close();
      console.log("bound");
      setInterval(() => {}, 1000);
    } catch (e) {
      owner.close();
      assert.equal(e.code, "operation-failed");
      console.log("not-admitted");
    }
  } else if (mode === "retained" || mode === "parent") {
    const job = WindowsJob.create();
    if (mode === "retained") {
      retainCurrentProcessJobUntilExit(job);
      job.close();
      assert.throws(() => job.accounting(), e => e.code === "invalid-argument");
      assert.equal(isCurrentProcessInJob(), true);
      console.log("retained");
    } else {
      const child = job.spawn({ executable: fixture, commandLine: [fixture, "tree", process.argv[4]].map(quote).join(" ") });
      const result = await drain(child);
      assert.equal(result.code, 259);
      child.close();
      console.log(result.out.toString().trim());
      if (!isMainThread) await once(parentPort, "message");
    }
    if (isMainThread) setInterval(() => {}, 1000);
  } else if (mode === "nested") {
    const outer = WindowsJob.create();
    retainCurrentProcessJobUntilExit(outer);
    const inner = WindowsJob.create();
    const child = launch(inner, "process.stdout.write('nested')");
    assert.equal((await drain(child)).out.toString(), "nested");
    await until(() => inner.accounting().activeProcesses === 0);
    child.close(); inner.close();
    console.log("nested");
  }
}

function inputFixture(job, mode, args = [], stdin = "pipe") {
  return job.spawn({ executable: fixture, commandLine: [fixture, mode, ...args].map(quote).join(" "), stdin });
}
function collect(child) {
  const out = [], err = [];
  let outEnd = false, errEnd = false;
  return {
    poll() {
      for (let i = 0; i < 4; i++) {
        if (!outEnd) { const b = child.readStdout(65536); if (b === null) outEnd = true; else if (b.length) out.push(b); }
        if (!errEnd) { const b = child.readStderr(65536); if (b === null) errEnd = true; else if (b.length) err.push(b); }
      }
      return outEnd && errEnd;
    },
    out: () => Buffer.concat(out).toString(), err: () => Buffer.concat(err).toString(),
  };
}
function inputHash(bytes) {
  let hash = 2166136261;
  for (const b of bytes) hash = (Math.imul(hash, 16777619) ^ b) >>> 0;
  return hash;
}
async function inputs() {
  const dir = mkdtempSync(join(tmpdir(), "proc-safe-input-"));
  const job = WindowsJob.create();
  try {
    for (const stdin of [undefined, "null"]) {
      const path = join(dir, stdin ?? "default");
      // Omission, not the helper's default parameter, tests the original spawn behavior.
      const child = job.spawn({ executable: fixture, commandLine: [fixture, "stdin-eof", path].map(quote).join(" "), stdin });
      try {
        assert.throws(() => child.writeStdin(Buffer.from([1])), e => e.code === "invalid-argument");
        child.closeStdin(); child.closeStdin();
        assert.equal((await drain(child)).code, 0);
        assert.equal(readFileSync(path, "utf8"), "0");
      } finally { child.close(); }
    }
    const gate = join(dir, "gate");
    const child = inputFixture(job, "stdin", [gate]);
    let pin;
    try {
      const output = collect(child);
      await until(() => { output.poll(); return output.out() === "ready 0 1\n"; });
      // Binding identity precedes the first explicit byte release. Spawn sends none.
      pin = PinnedProcess.open(child.pid);
      assert.equal(pin.identity.exited, false);
      const verified = PinnedProcess.open(child.pid, { expect: { startTimeMicros: pin.identity.startTimeMicros } });
      verified.close();
      assert.ok(job.processIds().includes(child.pid));
      const bytes = Buffer.from(Array.from({ length: 1024 * 1024 }, (_, i) => i % 251));
      const hash = inputHash(bytes);
      let offset = 0;
      // Fixture cannot read until gate release: a large request must still make
      // a positive bounded attempt, then eventually observe zero without waiting.
      const first = child.writeStdin(bytes);
      assert.ok(first > 0 && first <= 65536 && first < bytes.length);
      offset += first;
      while (offset < bytes.length) {
        const n = child.writeStdin(bytes.subarray(offset));
        assert.notEqual(n, null);
        if (n === 0) break;
        offset += n;
      }
      assert.ok(offset < bytes.length);
      await pause(); // Scheduling remains available while the child cannot read.
      writeFileSync(gate, "release");
      let closed = false;
      await until(() => {
        const ended = output.poll();
        if (offset < bytes.length) {
          const n = child.writeStdin(bytes.subarray(offset));
          assert.notEqual(n, null);
          offset += n;
        }
        if (offset === bytes.length && !closed) {
          bytes.fill(0); // Accepted data is not retained as a later JS-buffer write.
          child.closeStdin(); child.closeStdin(); closed = true;
        }
        return ended && child.exitCode() !== null;
      });
      assert.equal(child.exitCode(), 0);
      assert.equal(output.out(), 'ready 0 1\n' + 'x'.repeat(180000) + '\nend 1048576 ' + hash + '\n');
      assert.equal(output.err(), "y".repeat(160000));
      assert.equal(pin.identity.exited, true);
      assert.throws(() => child.writeStdin(Buffer.from([1])), e => e.code === "invalid-argument");
    } finally { pin?.close(); child.close(); }

    const closed = inputFixture(job, "stdin-closed");
    try {
      const output = collect(closed);
      await until(() => { output.poll(); return output.out() === "closed\n"; });
      assert.equal(closed.exitCode(), null);
      assert.equal(closed.writeStdin(Buffer.from([1])), null);
      assert.equal(closed.writeStdin(Buffer.from([1])), null);
      closed.closeStdin(); closed.closeStdin();
      assert.throws(() => closed.writeStdin(Buffer.from([1])), e => e.code === "invalid-argument");
      execFileSync(fixture, ["kill", String(closed.pid)]);
      assert.equal((await drain(closed)).code, 81);
    } finally { closed.close(); }

    // Closing just the child owner produces EOF; the job remains open and live.
    const closePath = join(dir, "child-close");
    const release = inputFixture(job, "stdin-eof", [closePath]);
    const releasedPin = PinnedProcess.open(release.pid);
    release.close(); release.close();
    try {
      await until(() => releasedPin.identity.exited);
      assert.equal(readFileSync(closePath, "utf8"), "0");
      assert.throws(() => release.closeStdin(), e => e.code === "invalid-argument");
    } finally { releasedPin.close(); }

    // A root exit is not input EOF: the detached/new-group descendant inherited
    // only the child read endpoint and may keep consuming after the root exits.
    const root = inputFixture(job, "stdin-tree");
    try {
      const output = collect(root);
      await until(() => { output.poll(); return root.exitCode() === 259 && /descendant \d+\n/.test(output.out()); });
      const descendantPid = Number(/descendant (\d+)\n/.exec(output.out())[1]);
      assert.ok(job.processIds().includes(descendantPid));
      assert.ok(job.accounting().activeProcesses > 0);
      const bytes = Buffer.from("after-root-exit");
      assert.equal(root.writeStdin(bytes), bytes.length);
      root.closeStdin();
      await until(() => output.poll());
      assert.match(output.out(), /descendant \d+\n/);
      assert.ok(output.out().endsWith('\nend ' + bytes.length + ' ' + inputHash(bytes) + '\n'));
      assert.equal(output.err(), "y".repeat(160000));
      await until(() => job.accounting().activeProcesses === 0);
    } finally { root.close(); }

    const cancelled = inputFixture(job, "stdin", [join(dir, "never-release")]);
    try {
      const output = collect(cancelled);
      await until(() => { output.poll(); return output.out() === "ready 0 1\n"; });
      assert.ok(cancelled.writeStdin(Buffer.alloc(1024 * 1024)) > 0);
      job.terminate(38);
      await until(() => cancelled.exitCode() === 38);
      assert.equal(cancelled.writeStdin(Buffer.from([1])), null);
      cancelled.closeStdin();
      await until(() => output.poll());
    } finally { cancelled.close(); }

    // Failed launches own and close both private endpoints before propagating.
    const count = () => Number(execFileSync(fixture, ["handle-count", String(process.pid)], { encoding: "utf8" }).trim());
    // ARM64 Windows retains process-wide handles on the first missing-executable
    // CreateProcessW failure, including with NUL stdin and in an independent
    // Win32 control. Initialize that existing path before measuring pipe cleanup.
    assert.throws(() => job.spawn({ executable: "C:\\missing.exe", commandLine: "missing" }), e => e.code === "operation-failed");
    const before = count();
    for (let i = 0; i < 4; i++) {
      assert.throws(() => job.spawn({ executable: "C:\\missing.exe", commandLine: "missing", stdin: "pipe" }), e => e.code === "operation-failed" && !e.message.includes("proc-safe-input-"));
    }
    assert.equal(count(), before);
  } finally { job.close(); rmSync(dir, { recursive: true, force: true }); }
}
async function inputLifetimes(worker) {
  const dir = mkdtempSync(join(tmpdir(), "proc-safe-input-owner-"));
  let parent, pin;
  try {
    const nested = host("nested-input", worker, [join(dir, "nested")]);
    assert.equal(await nested.next(), "nested-input");
    if (worker) assert.equal(await nested.next(), "worker-exited");
    assert.deepEqual(await nested.exit, [0, null], nested.errors());
    const path = join(dir, "eof");
    parent = host("input-parent", worker, [path]);
    pin = PinnedProcess.open(Number(await parent.next()));
    assert.equal(pin.identity.exited, false);
    if (worker) {
      parent.child.stdin.write("release\n");
      assert.equal(await parent.next(), "worker-exited");
    } else { execFileSync(fixture, ["kill", String(parent.child.pid)]); }
    await until(() => pin.identity.exited);
    assert.equal(readFileSync(path, "utf8"), "0", "owner death must close input, independently of job termination");
  } finally {
    if (pin && !pin.identity.exited) execFileSync(fixture, ["kill", String(pin.identity.pid)]);
    pin?.close(); parent?.child.kill(); if (parent) await parent.exit;
    rmSync(dir, { recursive: true, force: true });
  }
}

// Unlike nested-input, this host is ALREADY admitted into its parent's outer
// Job before it creates the fresh inner Job. No outer handle enters this host.
async function doctorOrderChild() {
  const retain = () => {
    const inner = WindowsJob.create(); // Keep the default kill-on-close behavior.
    retainCurrentProcessJobUntilExit(inner);
    inner.close(); // Consumed owner: must not close the retained native handle.
    assert.equal(isCurrentProcessInJob(), true);
  };
  if (!isMainThread) { retain(); return; }
  if (process.argv[3] === "worker") {
    const worker = new Worker(new URL(import.meta.url), { argv: ["doctor-retain"] });
    const [code] = await once(worker, "exit");
    assert.equal(code, 0);
  } else { retain(); }
  // Both retention and actual Worker exit precede even the first stdin read.
  console.log("inner-retained");
  const chunks = [];
  for await (const bytes of process.stdin) chunks.push(bytes);
  const input = Buffer.concat(chunks);
  assert.equal(input.length, 14);
  assert.equal(inputHash(input), inputHash(Buffer.from("doctor-private")));
  const tree = spawn(fixture, ["tree", process.argv[4]], { stdio: ["ignore", "pipe", "inherit"] });
  const closed = once(tree, "close");
  let output = "";
  tree.stdout.on("data", bytes => output += bytes);
  const [code] = await closed;
  // Bun 1.4.4 exposes the low byte of this process exit status on Windows.
  assert.equal(code, process.versions.bun ? 259 & 0xff : 259);
  await until(() => existsSync(process.argv[4]));
  const descendant = Number(readFileSync(process.argv[4], "utf8"));
  assert.equal(Number(output.trim()), descendant);
  console.log(`input-accepted descendant ${descendant}`);
  await until(() => existsSync(process.argv[5]));
  // Exit closes the retained inner Job and must kill its still-live descendant.
}

async function doctorOrder(worker, terminate) {
  const dir = mkdtempSync(join(tmpdir(), "proc-safe-doctor-order-"));
  const outer = WindowsJob.create(); // Parent keeps sole ownership throughout.
  let child, pin, descendant;
  try {
    const finish = join(dir, "finish"), ready = join(dir, "descendant");
    child = outer.spawn({ executable: process.execPath,
      commandLine: [process.execPath, entry, "doctor-order", worker ? "worker" : "main", ready, finish].map(quote).join(" "), stdin: "pipe" });
    pin = PinnedProcess.open(child.pid);
    assert.ok(pin);
    const output = collect(child);
    await until(() => { output.poll(); return output.out() === "inner-retained\n"; });
    assert.equal(pin.identity.exited, false);
    assert.ok(outer.processIds().includes(child.pid));
    assert.ok(outer.accounting().activeProcesses > 0);
    const verified = PinnedProcess.open(child.pid, { expect: { startTimeMicros: pin.identity.startTimeMicros } });
    verified.close();
    const bytes = Buffer.from("doctor-private");
    assert.equal(child.writeStdin(bytes), bytes.length);
    child.closeStdin();
    await until(() => { output.poll(); return /input-accepted descendant \d+\n/.test(output.out()); });
    const pid = Number(/input-accepted descendant (\d+)\n/.exec(output.out())[1]);
    descendant = PinnedProcess.open(pid);
    assert.ok(descendant);
    assert.equal(descendant.identity.exited, false);
    assert.ok(outer.processIds().includes(pid));
    assert.ok(outer.accounting().activeProcesses >= 2, "outer must observe both live nested members before zero");
    if (terminate) outer.terminate(39);
    else writeFileSync(finish, "exit");
    await until(() => pin.identity.exited && descendant.identity.exited);
    await until(() => outer.accounting().activeProcesses === 0);
    const result = await drain(child);
    assert.equal(result.code, terminate ? 39 : 0, result.err.toString());
  } finally {
    // Only the parent's task-owned outer Job is terminated, including on failure.
    try { outer.terminate(40); } finally {
      child?.close(); pin?.close(); descendant?.close(); outer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function operations() {
  assert.equal(isSupported(), true);
  const self = PinnedProcess.open(process.pid);
  assert.ok(Object.isFrozen(self));
  assert.equal(self.identity.pid, process.pid);
  assert.equal(self.identity.exited, false);
  assert.equal(self.identity.parentPid, process.ppid);
  assert.ok(Object.isFrozen(self.identity));
  assert.equal(self.access, "observe");
  assert.throws(() => PinnedProcess.open(process.pid, { access: "invalid" }), e => e.code === "invalid-argument");
  assert.throws(() => PinnedProcess.open(process.pid, { expect: { imagePath: "C:\\wrong.exe" } }), e => e.code === "operation-failed");
  assert.throws(() => PinnedProcess.open(process.pid, { expect: { startTimeMicros: self.identity.startTimeMicros + 1 } }), e => e.code === "operation-failed");
  const verified = PinnedProcess.open(process.pid, { expect: { imagePath: self.imagePath, startTimeMicros: self.identity.startTimeMicros } });
  verified.close(); self.close(); self.close();
  assert.throws(() => self.identity, e => e.code === "invalid-argument");
  const name = `Local\\proc-safe-${process.pid}-${isMainThread ? "main" : "worker"}-${Date.now()}`;
  assert.equal(WindowsJob.open(name), null);
  const job = WindowsJob.create({ name });
  assert.ok(Object.isFrozen(job));
  assert.throws(() => WindowsJob.create({ name }), e => e.code === "operation-failed");
  const peer = WindowsJob.open(name);
  assert.deepEqual(peer.processIds(), []);
  assert.deepEqual(job.accounting(), { activeProcesses: 0, totalProcesses: 0, terminatedProcesses: 0 });
  peer.close();
  const membership = job.spawn({ executable: fixture, commandLine: [fixture, "membership"].map(quote).join(" ") });
  assert.equal((await drain(membership)).out.toString().trim(), "1 true", "admission precedes child execution and creates no console");
  membership.close();
  assert.throws(() => job.spawn({ executable: "C:\\missing.exe", commandLine: "missing" }), e => e.code === "operation-failed");
  assert.throws(() => job.spawn({ executable: process.execPath, commandLine: "x", env: { PATH: "a", Path: "b" } }), e => e.code === "invalid-argument");
  const child = launch(job, `process.stdout.write('x'.repeat(180000));process.stderr.write('y'.repeat(160000));`);
  assert.ok(Object.isFrozen(child));
  const pid = child.pid;
  const pin = PinnedProcess.open(pid);
  assert.equal(pin.identity.pid, pid);
  assert.ok(job.processIds().includes(pid));
  const result = await drain(child);
  assert.equal(result.code, 0, result.err.toString());
  assert.equal(result.out.toString(), "x".repeat(180000));
  assert.equal(result.err.toString(), "y".repeat(160000));
  assert.equal(pin.identity.exited, true);
  await until(() => job.accounting().activeProcesses === 0);
  assert.deepEqual(job.processIds(), []);
  child.close(); child.close(); pin.close();
  assert.throws(() => child.readStdout(1), e => e.code === "invalid-argument");
  const waiting = launch(job, "setInterval(()=>{},1000)");
  assert.equal(waiting.exitCode(), null);
  assert.equal(waiting.readStdout(20).length, 0);
  job.terminate(259);
  assert.equal((await drain(waiting)).code, 259);
  waiting.close(); job.close(); job.close();
  assert.throws(() => job.processIds(), e => e.code === "invalid-argument");

  const external = spawn(fixture, ["owner"], { stdio: ["pipe", "pipe", "inherit"] });
  const externalExit = once(external, "exit");
  const externalLines = createInterface({ input: external.stdout })[Symbol.asyncIterator]();
  assert.equal((await externalLines.next()).value, "ready");
  const externalPin = PinnedProcess.open(external.pid, { access: "job-member" });
  const admitted = WindowsJob.create();
  admitted.assignProcess(externalPin);
  assert.ok(admitted.processIds().includes(external.pid));
  admitted.terminate(37);
  assert.equal((await externalExit)[0], 37);
  assert.equal(externalPin.identity.exited, true);
  externalPin.close(); admitted.close();

  const nonKilling = WindowsJob.create({ killOnJobClose: false });
  const survivor = launch(nonKilling, "setInterval(()=>{},1000)");
  nonKilling.close();
  assert.equal(survivor.exitCode(), null);
  execFileSync(fixture, ["kill", String(survivor.pid)]);
  assert.equal((await drain(survivor)).code, 81);
  survivor.close();

  const dir = mkdtempSync(join(tmpdir(), "proc-safe-job-"));
  try {
    const tree = WindowsJob.create();
    const root = tree.spawn({ executable: fixture, commandLine: [fixture, "tree", join(dir, "ready")].map(quote).join(" ") });
    const output = await drain(root);
    assert.equal(output.code, 259);
    const descendantPid = Number(output.out.toString().trim());
    await until(() => existsSync(join(dir, "ready")));
    const descendant = PinnedProcess.open(descendantPid);
    assert.equal(descendant.identity.exited, false);
    assert.ok(tree.processIds().includes(descendantPid));
    assert.ok(tree.accounting().activeProcesses > 0, "pipe EOF must not mean extinction");
    tree.close();
    await until(() => descendant.identity.exited);
    descendant.close(); root.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
  await exitedOwners();
  await accessModes();
}

async function accessModes() {
  const target = spawn(fixture, ["owner"], { stdio: ["pipe", "pipe", "inherit"] });
  const exit = once(target, "exit");
  const input = createInterface({ input: target.stdout })[Symbol.asyncIterator]();
  const job = WindowsJob.create();
  try {
    assert.equal((await input.next()).value, "ready");
    target.stdin.write("count\n"); const beforeCount = Number((await input.next()).value);
    const beforeJob = isCurrentProcessInJob();
    for (const [access, mask] of [["observe", 0x1000], ["lifetime-owner", 0x101040], ["job-member", 0x1101]]) {
      const pin = PinnedProcess.open(target.pid, { access });
      try {
        assert.equal(pin.access, access);
        assert.equal(pin.identity.exited, false);
        assert.ok(pin.imagePath.endsWith("proc-safe-job-fixture.exe"));
        if (inspectPinAccess) assert.equal(inspectPinAccess(), mask);
        const wrongAccess = required => e => {
          assert.equal(e.code, "invalid-argument");
          assert.deepEqual(e.details, { reason: "insufficient-pin-access", required, actual: access });
          return true;
        };
        if (access !== "lifetime-owner") assert.throws(() => bindCurrentProcessLifetimeTo(pin), wrongAccess("lifetime-owner"));
        if (access !== "job-member") assert.throws(() => job.assignProcess(pin), wrongAccess("job-member"));
        assert.deepEqual(job.accounting(), { activeProcesses: 0, totalProcesses: 0, terminatedProcesses: 0 });
        assert.equal(isCurrentProcessInJob(), beforeJob);
        target.stdin.write("count\n"); assert.equal(Number((await input.next()).value), beforeCount, "rejected bind must not leave a remote handle");
      } finally { pin.close(); }
    }
  } finally { job.close(); target.stdin.write("exit\n"); await exit; }

  if (openPinWithoutDebug) await deniedAccess();
}

async function deniedAccess() {
  const target = spawn(fixture, ["owner"], { stdio: ["pipe", "pipe", "inherit"] });
  const targetExit = once(target, "exit");
  const input = createInterface({ input: target.stdout })[Symbol.asyncIterator]();
  let observer;
  try {
    assert.equal((await input.next()).value, "ready");
    target.stdin.write("deny-duplicate\n");
    assert.equal((await input.next()).value, "denied");
    const opened = openPinWithoutDebug(target.pid, "observe");
    assert.ok(opened);
    observer = opened.process;
    assert.equal(opened.grantedAccess, 0x1000);
    assert.equal(observer.access, "observe");
    assert.equal(observer.identity.exited, false);
    assert.ok(observer.imagePath.endsWith("proc-safe-job-fixture.exe"));
    assert.throws(() => openPinWithoutDebug(target.pid, "lifetime-owner"), e => e instanceof ProcSafeError && e.code === "access-denied");
    // A second helper call must work after the error path reverted impersonation.
    const again = openPinWithoutDebug(target.pid, "observe");
    assert.ok(again);
    try { assert.equal(again.grantedAccess, 0x1000); } finally { again.process.close(); }
    target.stdin.write("exit\n");
    assert.deepEqual(await targetExit, [0, null]);
    assert.equal(observer.identity.exited, true);
  } finally {
    observer?.close();
    if (target.exitCode === null && target.signalCode === null) target.stdin.write("exit\n");
    await targetExit;
  }
}

async function environments() {
  const job = WindowsJob.create();
  const sentinel = `PROC_SAFE_JOB_PARENT_${process.pid}_${threadId}`;
  const explicit = { PROC_SAFE_JOB_EXPLICIT: "explicit-value", PROC_SAFE_JOB_SECOND: "second-value" };
  const requested = [sentinel, ...Object.keys(explicit)];
  // Windows may supply architecture metadata even for an explicit empty block.
  // https://learn.microsoft.com/en-us/windows/win32/winprog64/wow64-implementation-details
  const osInjected = new Set(["PROCESSOR_ARCHITECTURE"]);
  try {
    process.env[sentinel] = "parent-only";
    for (const env of [undefined, {}, explicit]) {
      // The fixture observes the actual environment without Node's SystemRoot requirement.
      const c = job.spawn({ executable: fixture, commandLine: [fixture, "environment", ...requested].map(quote).join(" "), env });
      try {
        const observed = await drain(c);
        assert.equal(observed.code, 0, observed.err.toString());
        const snapshot = JSON.parse(observed.out.toString());
        assert.equal(snapshot.requested[sentinel], env === undefined ? "parent-only" : null);
        if (env !== undefined) {
          assert.ok(snapshot.keys.every(key => Object.hasOwn(env, key) || osInjected.has(key)), JSON.stringify(snapshot.keys));
          for (const key of Object.keys(explicit)) assert.equal(snapshot.requested[key], env[key] ?? null);
          for (const key of Object.keys(env)) assert.ok(snapshot.keys.includes(key));
        } else { assert.ok(snapshot.keys.includes(sentinel)); }
      } finally { c.close(); }
    }
  } finally { delete process.env[sentinel]; job.close(); }
}

async function exitedOwners() {
  for (const alreadyExited of [false, true]) {
    const child = spawn(fixture, ["owner"], { stdio: ["pipe", "pipe", "inherit"] });
    const exit = once(child, "exit");
    const input = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    assert.equal((await input.next()).value, "ready");
    const retained = PinnedProcess.open(child.pid, { access: "lifetime-owner" });
    try {
      assert.equal(retained.identity.exited, false);
      child.stdin.write("exit\n"); await exit;
      // Exercise both exit immediately between pin/bind and an already-exited retained pin.
      // Reopening an exited PID would query an image Windows may have already released.
      if (alreadyExited) await new Promise(resolve => setImmediate(resolve));
      assert.equal(retained.identity.exited, true);
      const count = () => Number(execFileSync(fixture, ["handle-count", String(child.pid)], { encoding: "utf8" }).trim());
      const beforeCount = count();
      const beforeJob = isCurrentProcessInJob();
      assert.throws(() => bindCurrentProcessLifetimeTo(retained), e => e.code === "operation-failed" && e.message.includes("exited"));
      assert.equal(isCurrentProcessInJob(), beforeJob);
      assert.equal(count(), beforeCount);
    } finally { retained.close(); child.kill(); await exit; }
  }
}

async function faultProof(worker) {
  const child = spawn(fixture, ["owner"], { stdio: ["pipe", "pipe", "inherit"] });
  const exit = once(child, "exit");
  const input = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  try {
    assert.equal((await input.next()).value, "ready");
    child.stdin.write("count\n"); const before = Number((await input.next()).value);
    const failed = host("fail-bind", worker, [String(child.pid)]);
    assert.equal(await failed.next(), "rolled-back");
    assert.deepEqual(await failed.exit, [0, null], failed.errors());
    child.stdin.write("count\n");
    assert.equal(Number((await input.next()).value), before, "failed assignment leaked a remote handle");
  } finally { child.kill(); await exit; }
}

// The test addon pauses only the pipe setup to let an independent local client
// connect first. The ordinary native launch and verification checks remain in place.
async function competingInput() {
  const dir = mkdtempSync(join(tmpdir(), "proc-safe-competitor-"));
  const outcome = join(dir, "outcome");
  const launched = join(dir, "launched");
  const job = WindowsJob.create();
  try {
    interceptNextInput(fixture, outcome);
    assert.throws(() => job.spawn({ executable: fixture, commandLine: [fixture, "mark-launch", launched].map(quote).join(" "), stdin: "pipe" }),
      e => e.code === "operation-failed" && e.message.includes("Win32 231") && !e.message.includes("proc-safe-input-"));
    const observed = await until(() => existsSync(outcome) && readFileSync(outcome, "utf8"));
    assert.equal(observed, "no-bytes");
    assert.equal(existsSync(launched), false);
    assert.equal(job.accounting().activeProcesses, 0);
  } finally { job.close(); rmSync(dir, { recursive: true, force: true }); }
}

async function lifetimes(worker) {
  const nested = host("nested", worker);
  assert.equal(await nested.next(), "nested");
  assert.deepEqual(await nested.exit, [0, null], nested.errors());
  const retained = host("retained", worker);
  assert.equal(await retained.next(), "retained");
  // The Worker has exited; its finalizer must not close the retained job and kill its host.
  if (worker) assert.equal(await retained.next(), "worker-exited");
  assert.equal(retained.child.exitCode, null);
  retained.child.kill(); await retained.exit;

  const dir = mkdtempSync(join(tmpdir(), "proc-safe-parent-"));
  try {
    const parent = host("parent", worker, [join(dir, "ready")]);
    const pid = Number(await parent.next());
    await until(() => existsSync(join(dir, "ready")));
    const descendant = PinnedProcess.open(pid);
    if (worker) {
      // Ordinary Worker-owned jobs close when the Worker exits.
      parent.child.stdin.write("release\n");
      assert.equal(await parent.next(), "worker-exited");
    } else {
      execFileSync(fixture, ["kill", String(parent.child.pid)]);
    }
    await until(() => descendant.identity.exited);
    descendant.close(); parent.child.kill(); await parent.exit;
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const owner = spawn(fixture, ["owner"], { stdio: ["pipe", "pipe", "inherit"] });
  const ownerExit = once(owner, "exit");
  const lines = createInterface({ input: owner.stdout })[Symbol.asyncIterator]();
  const next = async () => (await lines.next()).value;
  let boundPin;
  try {
    assert.equal(await next(), "ready");
    owner.stdin.write("count\n"); const before = Number(await next());
    const bound = host("bind", worker, [String(owner.pid)]);
    assert.equal(await bound.next(), "bound");
    boundPin = PinnedProcess.open(bound.child.pid);
    assert.equal(boundPin.identity.exited, false);
    owner.stdin.write("count\n"); assert.equal(Number(await next()), before + 1, "exactly one job handle belongs to owner");
    owner.stdin.write("exit\n"); await ownerExit;
    await bound.exit;
    assert.equal(boundPin.identity.exited, true, "owner death must kill the admitted host");
  } finally { boundPin?.close(); owner.kill(); await ownerExit; }

  // The independent owner observes actual handle arrival, then exits during the native handoff.
  for (let iteration = 0; iteration < 4; iteration++) {
    const racing = spawn(fixture, ["owner"], { stdio: ["pipe", "pipe", "inherit"] });
    const raceExit = once(racing, "exit");
    const input = createInterface({ input: racing.stdout })[Symbol.asyncIterator]();
    await input.next(); racing.stdin.write("watch\n"); await input.next();
    const bound = host("bind", worker, [String(racing.pid)]);
    await raceExit;
    const [code] = await bound.exit;
    // Kill-on-close may itself report exit code zero; survival, not status, is the invariant.
    assert.equal(typeof code, "number", "handoff race must terminate or return not-admitted");
  }
}

const mode = process.argv[2];
if (mode === "doctor-order" || mode === "doctor-retain") {
  await doctorOrderChild();
} else if (isMainThread && process.argv[3] === "worker") {
  const worker = new Worker(new URL(import.meta.url), { argv: process.argv.slice(2) });
  worker.on("error", e => { throw e; });
  if (mode === "parent" || mode === "input-parent") process.stdin.once("data", () => worker.postMessage("release"));
  await once(worker, "exit");
  console.log("worker-exited");
  if (mode === "retained" || mode === "parent" || mode === "input-parent") setInterval(() => {}, 1000);
} else if (["bind", "fail-bind", "retained", "parent", "nested", "input-parent", "nested-input"].includes(mode)) {
  await childMode(mode);
} else if (mode === "operations") {
  await operations();
  parentPort?.postMessage("passed");
} else if (mode === "inputs") {
  await inputs();
  if (isMainThread) {
    const worker = new Worker(new URL(import.meta.url), { argv: ["inputs"] });
    const exited = once(worker, "exit");
    await once(worker, "message"); await exited;
    await inputLifetimes(false); await inputLifetimes(true);
    for (const worker of [false, true]) for (const terminate of [false, true]) await doctorOrder(worker, terminate);
    console.log(JSON.stringify({ inputs: 2, inputLifetimes: 2, doctorOrder: 4 }));
  } else { parentPort.postMessage("passed"); }
} else if (mode === "environments") {
  await environments();
  if (isMainThread) {
    const worker = new Worker(new URL(import.meta.url), { argv: ["environments"], env: SHARE_ENV });
    const exited = once(worker, "exit");
    await once(worker, "message"); await exited;
    console.log(JSON.stringify({ environments: 2 }));
  } else { parentPort.postMessage("passed"); }
} else if (mode === "fault-proof") {
  assert.equal(typeof injectAssignmentFailure, "function");
  await accessModes();
  const worker = new Worker(new URL(import.meta.url), { argv: ["access-proof"] });
  const exited = once(worker, "exit");
  await once(worker, "message"); await exited;
  await faultProof(false); await faultProof(true);
  await competingInput();
  const competitorWorker = new Worker(new URL(import.meta.url), { argv: ["competing-proof"] });
  const competitorExit = once(competitorWorker, "exit");
  await once(competitorWorker, "message"); await competitorExit;
  console.log(JSON.stringify({ faultProof: 2, accessProof: 2, competingInput: 2 }));
} else if (mode === "competing-proof") {
  await competingInput();
  parentPort.postMessage("passed");
} else if (mode === "access-proof") {
  await accessModes();
  parentPort.postMessage("passed");
} else {
  await operations();
  const worker = new Worker(new URL(import.meta.url), { argv: ["operations"] });
  await once(worker, "message"); await once(worker, "exit");
  await lifetimes(false); await lifetimes(true);
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, passed: 2, lifetimes: 2 }));
}
