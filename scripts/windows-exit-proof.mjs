import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { hostNativeTarget } from "./native-targets.mjs";
import { readProcessIdentity } from "../dist/identity.js";

export async function proveRetainedExit() {
  const target = hostNativeTarget();
  const fixture = fileURLToPath(new URL(`../target/${target.rust}/release/proc-safe-retained-fixture.exe`, import.meta.url));
  const helper = spawn(fixture, [process.versions.bun ? "node.exe" : process.execPath], { stdio: ["pipe", "pipe", "inherit"] });
  const closed = once(helper, "close");
  try {
    const lines = createInterface({ input: helper.stdout })[Symbol.asyncIterator]();
    const pid = Number((await lines.next()).value);
    assert.ok(Number.isInteger(pid) && pid > 0);
    const alive = readProcessIdentity(pid);
    assert.equal(alive.pid, pid);
    assert.equal(alive.exited, false);
    helper.stdin.write("exit\n");
    assert.equal((await lines.next()).value, "retained");
    const retained = readProcessIdentity(pid);
    assert.equal(retained.exited, true);
    assert.equal(retained.pid, alive.pid);
    assert.equal(retained.startTimeMicros, alive.startTimeMicros);
    const worker = new Worker(new URL("./worker-proof.mjs", import.meta.url), { workerData: { pid } });
    const workerExit = once(worker, "exit");
    const [observation] = await once(worker, "message");
    assert.deepEqual(observation.identity, retained);
    assert.deepEqual(await workerExit, [0]);
  } finally {
    helper.stdin.end("release\n");
    assert.deepEqual(await closed, [0, null]);
  }
}
