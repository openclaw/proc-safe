import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { WindowsJob, PinnedProcess, bindCurrentProcessLifetimeTo, retainCurrentProcessJobUntilExit, isCurrentProcessInJob, isSupported } from "../dist/windows-job.js";

const fixture = resolve(`target/${process.arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc/release/proc-safe-job-fixture.exe`);
const entry = fileURLToPath(import.meta.url);
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
function host(mode, worker = false, extra = [], restricted = false) {
  const args = [entry, mode, worker ? "worker" : "main", ...extra];
  const child = restricted
    ? spawn(fixture, ["restricted-run", process.execPath, ...args], { stdio: ["pipe", "pipe", "pipe"] })
    : spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let errors = "";
  child.stderr.on("data", b => errors += b);
  const exit = once(child, "exit");
  return { child, next: async () => { const line = await lines.next(); assert.equal(line.done, false, errors); return line.value; }, exit, errors: () => errors };
}

async function childMode(mode) {
  if (mode === "bind" || mode === "fail-bind") {
    const owner = PinnedProcess.open(Number(process.argv[4]));
    assert.ok(owner);
    if (mode === "fail-bind") {
      assert.throws(() => bindCurrentProcessLifetimeTo(owner), e => e.code === "access-denied" && e.message.includes("AssignProcessToJobObject"));
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

async function operations() {
  assert.equal(isSupported(), true);
  const self = PinnedProcess.open(process.pid);
  assert.ok(Object.isFrozen(self));
  assert.equal(self.identity.pid, process.pid);
  assert.equal(self.identity.exited, false);
  assert.equal(self.identity.parentPid, process.ppid);
  assert.ok(Object.isFrozen(self.identity));
  assert.throws(() => PinnedProcess.open(process.pid, { imagePath: "C:\\wrong.exe" }), e => e.code === "operation-failed");
  assert.throws(() => PinnedProcess.open(process.pid, { startTimeMicros: self.identity.startTimeMicros + 1 }), e => e.code === "operation-failed");
  const verified = PinnedProcess.open(process.pid, { imagePath: self.imagePath, startTimeMicros: self.identity.startTimeMicros });
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
  const externalPin = PinnedProcess.open(external.pid);
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
}

async function environments() {
  const job = WindowsJob.create();
  try {
    for (const env of [undefined, {}]) {
      process.env.PROC_SAFE_JOB_INHERIT = "yes";
      // The fixture observes the actual environment without Node's SystemRoot requirement.
      const c = job.spawn({ executable: fixture, commandLine: [fixture, "environment"].map(quote).join(" "), env });
      try {
        const observed = await drain(c);
        assert.equal(observed.code, 0, observed.err.toString());
        const [value, count] = observed.out.toString().trim().split(" ");
        assert.equal(value, env ? "empty" : "yes");
        if (env) assert.equal(Number(count), 0, observed.out.toString());
        else assert.ok(Number(count) > 0);
      } finally { c.close(); }
    }
  } finally { delete process.env.PROC_SAFE_JOB_INHERIT; job.close(); }
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
  try {
    assert.equal(await next(), "ready");
    owner.stdin.write("count\n"); const before = Number(await next());
    const failed = host("fail-bind", worker, [String(owner.pid)], true);
    assert.equal(await failed.next(), "rolled-back");
    assert.deepEqual(await failed.exit, [0, null], failed.errors());
    owner.stdin.write("count\n"); assert.equal(Number(await next()), before, "failed assignment leaked a remote handle");
    const bound = host("bind", worker, [String(owner.pid)]);
    assert.equal(await bound.next(), "bound");
    owner.stdin.write("count\n"); assert.equal(Number(await next()), before + 1, "exactly one job handle belongs to owner");
    owner.stdin.write("exit\n"); await ownerExit;
    assert.notEqual((await bound.exit)[0], 0, "owner death must kill the admitted host");
  } finally { owner.kill(); await ownerExit; }

  // The independent owner observes actual handle arrival, then exits during the native handoff.
  for (let iteration = 0; iteration < 4; iteration++) {
    const racing = spawn(fixture, ["owner"], { stdio: ["pipe", "pipe", "inherit"] });
    const raceExit = once(racing, "exit");
    const input = createInterface({ input: racing.stdout })[Symbol.asyncIterator]();
    await input.next(); racing.stdin.write("watch\n"); await input.next();
    const bound = host("bind", worker, [String(racing.pid)]);
    await raceExit;
    const [code] = await bound.exit;
    assert.ok(code !== null, "handoff race must terminate or return not-admitted");
    if (code === 0) assert.equal(await bound.next(), "not-admitted");
  }
}

const mode = process.argv[2];
if (isMainThread && process.argv[3] === "worker") {
  const worker = new Worker(new URL(import.meta.url), { argv: process.argv.slice(2) });
  worker.on("error", e => { throw e; });
  if (mode === "parent") process.stdin.once("data", () => worker.postMessage("release"));
  await once(worker, "exit");
  console.log("worker-exited");
  if (mode === "retained" || mode === "parent") setInterval(() => {}, 1000);
} else if (["bind", "fail-bind", "retained", "parent", "nested"].includes(mode)) {
  await childMode(mode);
} else if (mode === "operations") {
  await operations();
  parentPort?.postMessage("passed");
} else if (mode === "environments") {
  await environments();
  if (isMainThread) {
    const worker = new Worker(new URL(import.meta.url), { argv: ["environments"] });
    const exited = once(worker, "exit");
    await once(worker, "message"); await exited;
    console.log(JSON.stringify({ environments: 2 }));
  } else { parentPort.postMessage("passed"); }
} else {
  await operations();
  const worker = new Worker(new URL(import.meta.url), { argv: ["operations"] });
  await once(worker, "message"); await once(worker, "exit");
  await lifetimes(false); await lifetimes(true);
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, passed: 2, lifetimes: 2 }));
}
