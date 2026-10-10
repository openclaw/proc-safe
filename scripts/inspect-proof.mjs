import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { readProcessCommand, listProcesses, isSupported } from "../dist/inspect.js";
import { readProcessIdentity } from "../dist/identity.js";
import { hostNativeTarget } from "./native-targets.mjs";

const keys = ["PROC_SAFE_VISIBLE", "PROC_SAFE_EMPTY", "__proto__", "PROC_SAFE_MISSING",
  ...(process.platform === "win32" ? ["proc_safe_visible", "PrOc_SaFe_ViSiBlE", "proc_safe_äcase"] : ["proc_safe_visible"])];
function observe(pid, expected) {
  const command = readProcessCommand(pid, { environmentKeys: keys });
  assert.ok(command);
  assert.deepEqual(command.argv.slice(-expected.args.length), expected.args);
  if (expected.emptyArgv0) assert.equal(command.argv[0], "");
  assert.equal(normalize(command.executable).toLowerCase(), normalize(expected.executable).toLowerCase());
  assert.deepEqual(Object.keys(command.environment).sort(), ["PROC_SAFE_EMPTY", "PROC_SAFE_VISIBLE", "__proto__",
    ...(process.platform === "win32" ? ["proc_safe_visible", "PrOc_SaFe_ViSiBlE", "proc_safe_äcase"] : [])].sort());
  assert.equal(command.environment.PROC_SAFE_VISIBLE, "chosen=é🦞");
  assert.equal(command.environment.PROC_SAFE_EMPTY, "");
  assert.equal(command.environment.__proto__, "literal");
  assert.equal(Object.hasOwn(command.environment, "PROC_SAFE_PRIVATE"), false);
  assert.equal(Object.hasOwn(command.environment, "PATH"), false);
  assert.equal(Object.isFrozen(command), true);
  assert.equal(Object.isFrozen(command.argv), true);
  assert.equal(Object.isFrozen(command.environment), true);
  assert.deepEqual(readProcessCommand(pid).environment, {});
  if (process.platform === "win32") {
    assert.equal(resolve(command.cwd).toLowerCase(), resolve(expected.cwd).toLowerCase());
    assert.equal(typeof command.commandLine, "string");
    assert.equal(command.environment.proc_safe_visible, "chosen=é🦞");
    assert.equal(command.environment.PrOc_SaFe_ViSiBlE, "chosen=é🦞");
    assert.equal(command.environment.proc_safe_äcase, "ordinal case");
    const snapshot = listProcesses({ timeoutMs: 5000, includeCommand: true });
    assert.ok(snapshot.length > 0 && snapshot.length < 65536);
    assert.equal(new Set(snapshot.map(row => row.pid)).size, snapshot.length);
    const row = snapshot.find(row => row.pid === pid);
    assert.ok(row);
    assert.equal(row.owner, "same");
    assert.deepEqual(row.identity, readProcessIdentity(pid));
    assert.deepEqual(row.command, readProcessCommand(pid));
    assert.deepEqual(row.command.environment, {});
    assert.equal(Object.isFrozen(row), true);
    assert.equal(Object.isFrozen(row.identity), true);
  } else {
    assert.equal(command.cwd, undefined);
    assert.equal(command.commandLine, undefined);
  }
}

async function workerProof(pid, expected) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { pid, expected } });
  const closed = once(worker, "exit");
  assert.deepEqual(await once(worker, "message"), ["verified"]);
  assert.deepEqual(await closed, [0]);
}

async function childProof(executable, launch, args, cwd, emptyArgv0 = false) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const launcher = fileURLToPath(new URL(`../target/${hostNativeTarget().rust}/release/proc-safe-inspect-fixture${suffix}`, import.meta.url));
  const child = spawn(launcher, [emptyArgv0 ? "--launch-empty-argv0" : "--launch", executable, ...launch, ...args], {
    cwd,
    env: { ...process.env, PROC_SAFE_VISIBLE: "chosen=é🦞", PROC_SAFE_EMPTY: "", PROC_SAFE_PRIVATE: "must-not-leave-native", "PROC_SAFE_ÄCASE": "ordinal case", ["__proto__"]: "literal" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const closed = once(child, "close");
  let pid;
  try {
    const [ready] = await once(child.stdout, "data");
    pid = Number(String(ready).trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    const expected = { executable, args, cwd, emptyArgv0 };
    observe(pid, expected);
    await workerProof(pid, expected);
  } finally {
    if (pid) process.kill(pid);
    else child.kill();
    await closed;
  }
  // Once all handles have closed, no command remains. A retained object may still
  // exist briefly on Windows; it must throw, never claim a successful empty read.
  try { assert.equal(readProcessCommand(pid), null); }
  catch (error) {
    if (process.platform !== "win32" || readProcessIdentity(pid) === null) throw error;
    assert.ok(["operation-failed", "incomplete", "access-denied"].includes(error.code));
  }
}

function proveCensusOptions() {
  const rows = listProcesses({ timeoutMs: 5000 });
  assert.ok(rows.some(row => row.pid === process.pid && row.owner === "same" && row.identity));
  assert.ok(rows.every(row => row.command === undefined));
  // Idle has no user-mode process handle but remains in the complete PID list.
  assert.deepEqual(rows.find(row => row.pid === 0), { pid: 0, owner: "unknown" });
  assert.throws(() => listProcesses({ timeoutMs: Number.MIN_VALUE }), error => error.code === "timeout");
}

function observeLargeArguments(pid) {
  for (const options of [undefined, { environmentKeys: ["PROBE"] }]) {
    assert.throws(() => readProcessCommand(pid, options), error => error.code === "incomplete");
  }
}

async function largeArgumentsProof() {
  const fixture = fileURLToPath(new URL(`../target/${hostNativeTarget().rust}/release/proc-safe-inspect-fixture`, import.meta.url));
  const child = spawn(fixture, ["--large-argv"], { stdio: ["ignore", "pipe", "inherit"] });
  const closed = once(child, "close");
  let pid;
  try {
    const [ready] = await once(child.stdout, "data");
    pid = Number(String(ready).trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    observeLargeArguments(pid);
    const worker = new Worker(new URL(import.meta.url), { workerData: { pid, largeArguments: true } });
    const exited = once(worker, "exit");
    assert.deepEqual(await once(worker, "message"), ["verified"]);
    assert.deepEqual(await exited, [0]);
  } finally {
    if (pid) process.kill(pid, "SIGKILL");
    else child.kill();
    await closed;
  }
}

function observeSuspended(pid) {
  assert.ok(readProcessCommand(pid).argv.length > 0);
  let command;
  try { command = readProcessCommand(pid, { environmentKeys: ["PROBE", "pfz"] }); }
  catch (error) {
    assert.equal(error.code, "incomplete");
    assert.match(error.message, /ambiguous Darwin environment boundary/);
    return "refused";
  }
  assert.deepEqual(command.environment, { PROBE: "x" });
  return "read";
}

async function suspendedProof() {
  const fixture = fileURLToPath(new URL(`../target/${hostNativeTarget().rust}/release/proc-safe-inspect-fixture`, import.meta.url));
  const outcomes = new Set();
  // Cover every possible alignment of the argv/envp tail before dyld clears Apple data.
  for (let padding = 0; padding < 8; padding++) {
    const child = spawn(fixture, ["--suspended", process.execPath, "x".repeat(padding)], { stdio: ["ignore", "pipe", "inherit"] });
    const closed = once(child, "close");
    let pid;
    try {
      const [ready] = await once(child.stdout, "data");
      pid = Number(String(ready).trim());
      assert.ok(Number.isInteger(pid) && pid > 0);
      const outcome = observeSuspended(pid);
      outcomes.add(outcome);
      const worker = new Worker(new URL(import.meta.url), { workerData: { pid, suspended: true } });
      const exited = once(worker, "exit");
      assert.deepEqual(await once(worker, "message"), [outcome]);
      assert.deepEqual(await exited, [0]);
    } finally {
      if (pid) process.kill(pid, "SIGKILL");
      else child.kill();
      await closed;
    }
  }
  assert.deepEqual([...outcomes].sort(), ["read", "refused"]);
}

export async function proveInspection() {
  if (!["darwin", "win32"].includes(process.platform)) {
    assert.equal(isSupported(), false);
    assert.throws(() => readProcessCommand(process.pid), error => error.code === "unsupported-platform");
    assert.throws(() => listProcesses({ timeoutMs: 1000 }), error => error.code === "unsupported-platform");
    return { platform: process.platform, arch: process.arch, passed: 1 };
  }
  assert.equal(isSupported(), true);
  if (process.platform === "win32") {
    proveCensusOptions();
    const worker = new Worker(new URL(import.meta.url), { workerData: { censusOptions: true } });
    const exited = once(worker, "exit");
    assert.deepEqual(await once(worker, "message"), ["verified"]);
    assert.deepEqual(await exited, [0]);
  }
  const cwd = mkdtempSync(join(tmpdir(), "proc-safe-command-"));
  const args = ["spaces stay together", "", 'quote"inside', "trailing\\", "é🦞", "a=b"];
  try {
    await childProof(process.execPath, ["-e", "console.log(process.pid); setInterval(() => {}, 1000)", "--"], args, cwd);
    if (process.platform === "darwin") {
      await childProof(process.execPath, ["-e", "console.log(process.pid); setInterval(() => {}, 1000)", "--"], args, cwd, true);
      await suspendedProof();
      await largeArgumentsProof();
    }
    if (process.platform === "win32") {
      const executable = fileURLToPath(new URL("../target/inspect-child-x86.exe", import.meta.url));
      await childProof(executable, [], args, cwd);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
  return { platform: process.platform, arch: process.arch, passed: process.platform === "darwin" ? 7 : 5 };
}

if (!isMainThread) {
  if (workerData.censusOptions) { proveCensusOptions(); parentPort.postMessage("verified"); }
  else if (workerData.largeArguments) { observeLargeArguments(workerData.pid); parentPort.postMessage("verified"); }
  else if (workerData.suspended) parentPort.postMessage(observeSuspended(workerData.pid));
  else {
    observe(workerData.pid, workerData.expected);
    parentPort.postMessage("verified");
  }
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--rosetta")) {
    assert.equal(process.platform, "darwin");
    assert.equal(process.arch, "x64");
    assert.equal(execFileSync("/usr/sbin/sysctl", ["-in", "sysctl.proc_translated"], { encoding: "utf8" }).trim(), "1");
    assert.equal(isSupported(), false);
    assert.throws(() => readProcessCommand(process.pid), error => error.code === "unsupported-platform" && /Rosetta/.test(error.message));
    const worker = new Worker(new URL("./inspect-rosetta-worker.mjs", import.meta.url));
    const closed = once(worker, "exit");
    assert.deepEqual(await once(worker, "message"), ["verified"]);
    assert.deepEqual(await closed, [0]);
    console.log(JSON.stringify({ platform: "darwin", arch: "x64-rosetta", passed: 2 }));
  } else { console.log(JSON.stringify(await proveInspection())); }
}
