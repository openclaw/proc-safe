import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { ProcSafeError } from "../dist/errors.js";
import { isSupported, listProcesses, readProcessCommand } from "../dist/inspect.js";
import { readProcessIdentity } from "../dist/identity.js";

function observe(probe, expected) {
  // Check the syscall itself: sysctl(8) can silently omit a denied named query.
  assert.equal(execFileSync(probe, { encoding: "utf8" }).trim(), expected);
  assert.ok(expected === "denied" || (process.arch === "x64" && expected === "absent"));
  const identity = readProcessIdentity(process.pid);
  const rows = listProcesses({ timeoutMs: 5000 });
  assert.ok(rows.length > 0);
  assert.equal(new Set(rows.map(row => row.pid)).size, rows.length);
  assert.ok(rows.every(row => row.pid > 0 && row.command === undefined));
  const self = rows.find(row => row.pid === process.pid);
  assert.equal(self.owner, "same");
  assert.equal(self.parentPid, process.ppid);
  assert.deepEqual(self.identity, identity);
  assert.deepEqual(listProcesses({ timeoutMs: 5000, pids: [process.pid, process.pid] }), [self]);
  assert.deepEqual(listProcesses({ timeoutMs: 5000, pids: [] }), []);
  if (process.arch === "arm64" || expected === "absent") {
    assert.equal(isSupported(), true);
    const command = readProcessCommand(process.pid);
    assert.ok(command.argv.includes("--inside"));
    const selected = listProcesses({ timeoutMs: 5000, pids: [process.pid], includeCommand: true });
    assert.deepEqual(selected[0].command, command);
  } else {
    assert.equal(process.arch, "x64");
    assert.equal(isSupported(), false);
    for (const read of [
      () => readProcessCommand(process.pid),
      () => listProcesses({ timeoutMs: 5000, pids: [process.pid], includeCommand: true }),
    ]) {
      assert.throws(read, error => error instanceof ProcSafeError && error.code === "access-denied");
    }
    // Failed command preflight must not poison later census calls.
    assert.deepEqual(listProcesses({ timeoutMs: 5000, pids: [process.pid] }), [self]);
  }
}

assert.equal(process.platform, "darwin");
if (!isMainThread) {
  observe(workerData.probe, workerData.expected);
  parentPort.postMessage("verified");
} else if (process.argv[2] === "--inside") {
  const probe = process.argv[3];
  const expected = process.argv[4] ?? "denied";
  observe(probe, expected);
  const worker = new Worker(new URL(import.meta.url), { workerData: { probe, expected } });
  const exited = once(worker, "exit");
  assert.deepEqual(await once(worker, "message"), ["verified"]);
  assert.deepEqual(await exited, [0]);
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, runtime: process.versions.bun ? "bun" : "node", translationQuery: expected, passed: 2 }));
} else {
  const directory = mkdtempSync(join(tmpdir(), "proc-safe-seatbelt-"));
  try {
    const probe = join(directory, "translation-denial");
    execFileSync("cc", [fileURLToPath(new URL("../test/fixtures/darwin-translation.c", import.meta.url)), "-o", probe]);
    const baseline = execFileSync(probe, { encoding: "utf8" }).trim();
    assert.ok(["native", "translated", "absent"].includes(baseline));
    // Intel kernels do not register this key; x64 denial is proved under Rosetta.
    const expected = baseline === "absent" ? "absent" : "denied";
    const output = execFileSync("/usr/bin/sandbox-exec", [
      "-f", fileURLToPath(new URL("../test/fixtures/darwin-census.sb", import.meta.url)),
      process.execPath, fileURLToPath(import.meta.url), "--inside", probe, expected,
    ], { encoding: "utf8", timeout: 10_000 });
    process.stdout.write(output);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
