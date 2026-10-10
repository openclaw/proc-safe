import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";
import { assertSameIdentity, readAfterClose } from "./identity-proof-assertions.mjs";
import { readProcessIdentity } from "../dist/identity.js";

export async function proveZombie() {
  const directory = mkdtempSync(join(tmpdir(), "proc-safe-zombie-"));
  let helper;
  let closed;
  try {
    const executable = join(directory, "zombie");
    execFileSync("cc", [fileURLToPath(new URL("../test/fixtures/posix-zombie.c", import.meta.url)), "-o", executable]);
    helper = spawn(executable, [], { stdio: ["pipe", "pipe", "inherit"] });
    closed = once(helper, "close");
    const lines = createInterface({ input: helper.stdout })[Symbol.asyncIterator]();
    const pid = Number((await lines.next()).value);
    assert.ok(Number.isInteger(pid) && pid > 0);
    const alive = readProcessIdentity(pid);
    assert.equal(alive.pid, pid);
    assert.equal(alive.exited, false);
    helper.stdin.write("e");
    assert.equal((await lines.next()).value, "zombie");
    const zombie = readProcessIdentity(pid);
    assert.equal(zombie.exited, true);
    assert.equal(zombie.pid, alive.pid);
    assertSameIdentity({ ...zombie, exited: false }, alive);
    assert.equal(zombie.startTimeSinceBootMicros, alive.startTimeSinceBootMicros);
    const worker = new Worker(new URL("./worker-proof.mjs", import.meta.url), { workerData: { pid } });
    const workerExit = once(worker, "exit");
    const [observation] = await once(worker, "message");
    assertSameIdentity(observation.identity, zombie);
    assert.deepEqual(await workerExit, [0]);
    helper.stdin.end("r");
    assert.deepEqual(await closed, [0, null]);
    readAfterClose(pid, alive);
  } finally {
    if (helper && helper.exitCode === null) {
      helper.stdin.end("r");
      await closed;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}
