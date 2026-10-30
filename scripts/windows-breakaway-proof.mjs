import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { bindCurrentProcessLifetimeTo, PinnedProcess, WindowsJob, spawnWindowsProcess } from "../dist/windows-job.js";
import { readProcessCommand } from "../dist/inspect.js";

const entry = new URL(import.meta.url);
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(predicate) {
  const deadline = performance.now() + 8_000;
  while (performance.now() < deadline) { if (predicate()) return; await pause(); }
  throw new Error("Windows breakaway proof deadline expired");
}
const payload = `
process.send({pid: process.pid, value: 'hello', argv0: process.argv0, sample: process.env.PROC_SAFE_BREAKAWAY_SAMPLE});
setInterval(() => {}, 1000);
process.on('message', value => process.send({echo: value}));
process.on('disconnect', () => process.stdout.write('payload:owner-exited\\n'));
process.stdin.on('data', bytes => process.stdout.write('payload:' + bytes));
process.stdout.write('escaped:' + process.pid + '\\n');
`;
async function bounded(promise, describe = () => "") {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("stream closure did not propagate before launcher exit: " + describe())), 8_000);
    })]);
  } finally { clearTimeout(timer); }
}
async function closedStreamsBoundary() {
  const source = `
    const fs = require('node:fs');
    process.on('message', () => {fs.closeSync(4); process.disconnect();});
    process.send({pid: process.pid});
    setInterval(() => {}, 1000);
  `;
  const child = spawnWindowsProcess(process.execPath, ["-e", source], {
    // Node duplicates standard handles internally. An extra caller-owned pipe
    // tests EOF without depending on process.stdout's protected lifetime.
    breakawayFromJob: true, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc", "pipe"],
  });
  const exited = once(child, "exit");
  let payload;
  try {
    const [hello] = await once(child, "message");
    payload = PinnedProcess.open(hello.pid);
    let outputEnded = false, ipcDisconnected = false;
    const closed = Promise.all([
      once(child.stdio[4], "end").then(() => { outputEnded = true; }),
      once(child, "disconnect").then(() => { ipcDisconnected = true; }),
    ]);
    child.stdio[4].resume();
    child.send("close-streams");
    await bounded(closed, () => `outputEnded=${outputEnded}, ipcDisconnected=${ipcDisconnected}, launcherExit=${child.exitCode}, payloadExited=${payload.identity.exited}`);
    assert.equal(child.exitCode, null, "EOF and IPC closure precede launcher exit");
    assert.equal(payload.identity.exited, false, "payload remains alive after closing streams");
  } finally {
    if (payload && !payload.identity.exited) process.kill(payload.identity.pid, "SIGKILL");
    if (!payload && child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    payload?.close();
  }
}
async function owner(allowBreakaway, lifetimeOwnerPid) {
  const lifetimeOwner = PinnedProcess.open(lifetimeOwnerPid, { access: "lifetime-owner" });
  try { bindCurrentProcessLifetimeTo(lifetimeOwner, { allowBreakaway: true }); } finally { lifetimeOwner.close(); }
  const inner = WindowsJob.create({ allowBreakaway });
  inner.assignCurrentProcess();
  const ordinary = spawnWindowsProcess(process.execPath, ["-e", "setInterval(() => {},1000)"], { stdio: "ignore" });
  assert.ok(inner.processIds().includes(ordinary.pid), "ordinary child inherits the inner Job");
  const args = ["", "space value", 'quote"trail\\', "漢字"];
  const escaped = spawnWindowsProcess(process.execPath, ["-e", payload, "--", ...args], {
    breakawayFromJob: true,
    detached: true,
    argv0: "synthetic-node",
    env: { ...process.env, PROC_SAFE_BREAKAWAY_SAMPLE: "synthetic" },
    stdio: [0, 1, 2, "ipc"],
  });
  if (!allowBreakaway) {
    const [code] = await once(escaped, "exit");
    assert.notEqual(code, 0);
    process.stdout.write('refused:' + ordinary.pid + '\n');
    return;
  }
  const [hello] = await once(escaped, "message");
  assert.deepEqual(hello, { pid: hello.pid, value: "hello", argv0: "synthetic-node", sample: "synthetic" });
  // Observe the OS argv: a runtime CLI can normalize its JavaScript process.argv
  // independently of the command line that the spawn owner actually supplied.
  assert.deepEqual(readProcessCommand(hello.pid)?.argv, ["synthetic-node", "-e", payload, "--", ...args]);
  assert.equal(inner.processIds().includes(hello.pid), false, "explicit child leaves the inner Job");
  escaped.send({ sample: "JSON IPC" });
  const [echo] = await once(escaped, "message");
  assert.deepEqual(echo, { echo: { sample: "JSON IPC" } });
  await closedStreamsBoundary();
  process.stdout.write('ordinary:' + ordinary.pid + '\n');
}
async function runCase(worker, allowBreakaway) {
  const lifetimeOwner = spawn(process.execPath, ["-e", "setInterval(() => {},1000)"], { stdio: "ignore" });
  const lifetimeOwnerExited = once(lifetimeOwner, "exit");
  const child = spawn(process.execPath, [(await import("node:url")).fileURLToPath(entry), "owner", worker ? "worker" : "main", String(allowBreakaway), String(lifetimeOwner.pid)], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let errors = "";
  child.stderr.on("data", bytes => errors += bytes);
  const next = async () => {
    const line = await lines.next();
    assert.equal(line.done, false, errors);
    return line.value;
  };
  let escaped, ordinary;
  try {
    assert.equal(await next(), "owner-ready");
    child.send("start");
    const first = await next();
    if (allowBreakaway) {
      assert.match(first, /^escaped:\d+$/);
      escaped = PinnedProcess.open(Number(first.split(":")[1]));
      const second = await next();
      if (!/^ordinary:\d+$/.test(second)) {
        await exited;
        assert.fail(`Unexpected owner output ${JSON.stringify(second)}. Owner stderr: ${errors}`);
      }
      ordinary = PinnedProcess.open(Number(second.split(":")[1]));
      assert.equal(escaped.identity.exited, false);
    } else {
      assert.match(first, /^refused:\d+$/);
      ordinary = PinnedProcess.open(Number(first.split(":")[1]));
    }
    if (escaped) {
      child.stdin.write("before-stop\n");
      assert.equal(await next(), "payload:before-stop");
    }
    lifetimeOwner.kill();
    await lifetimeOwnerExited;
    await exited;
    await until(() => ordinary.identity.exited);
    if (escaped) {
      assert.equal(escaped.identity.exited, false, "explicit child outlives both Jobs");
      assert.equal(await next(), "payload:owner-exited");
      process.kill(escaped.identity.pid, "SIGKILL");
      await until(() => escaped.identity.exited);
    }
  } finally {
    if (escaped && !escaped.identity.exited) process.kill(escaped.identity.pid, "SIGKILL");
    escaped?.close(); ordinary?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    if (lifetimeOwner.exitCode === null && lifetimeOwner.signalCode === null) lifetimeOwner.kill();
    await lifetimeOwnerExited;
  }
}
if (!isMainThread) {
  await owner(workerData.allowBreakaway, workerData.lifetimeOwnerPid);
  await once(parentPort, "message");
} else if (process.argv[2] === "owner") {
  const started = once(process, "message");
  process.stdout.write("owner-ready\n");
  await started;
  if (process.argv[3] === "worker") {
    const worker = new Worker(entry, { workerData: { allowBreakaway: process.argv[4] === "true", lifetimeOwnerPid: Number(process.argv[5]) }, stdin: false, stdout: false, stderr: false });
    worker.on("error", error => { throw error; });
    await once(worker, "exit");
  } else await owner(process.argv[4] === "true", Number(process.argv[5]));
} else {
  for (const worker of [false, true]) {
    await runCase(worker, false);
    await runCase(worker, true);
  }
  console.log(JSON.stringify({ contexts: 2, ordinaryExtinguished: 4, escapedSurvived: 2, pipeAndJsonIpc: true }));
}
