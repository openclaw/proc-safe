import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readProcessAncestry } from "../dist/identity.js";
import { ProcSafeError } from "../dist/errors.js";
import { proveAncestryTransitions } from "./ancestry-transitions.mjs";

export async function proveAncestry() {
  assert.equal(proveAncestryTransitions(), 25);
  const full = readProcessAncestry(process.pid);
  assert.equal(full.chain[0].pid, process.pid);
  assert.ok(full.chain.every(identity => identity.pid > 1));
  assert.ok(full.complete || full.stoppedBy === "unreadable-parent");
  assert.equal(full.complete, ["root", "missing-parent", "recycled-parent", "through-pid"].includes(full.stoppedBy));
  const self = readProcessAncestry(process.pid, { throughPid: process.pid, maxDepth: 1 });
  assert.deepEqual(self.chain.map(identity => identity.pid), [process.pid]);
  assert.equal(self.complete, true);
  assert.equal(self.stoppedBy, "through-pid");

  const child = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await once(child.stdout, "data");
    const limited = readProcessAncestry(child.pid, { maxDepth: 1 });
    assert.deepEqual(limited.chain.map(identity => identity.pid), [child.pid]);
    assert.equal(limited.complete, false);
    assert.equal(limited.stoppedBy, "max-depth");
    const throughParent = readProcessAncestry(child.pid, { maxDepth: 2, throughPid: process.pid });
    assert.deepEqual(throughParent.chain.map(identity => identity.pid), [child.pid, process.pid]);
    assert.equal(throughParent.complete, true);
    assert.equal(throughParent.stoppedBy, "through-pid");
    const throughSelf = readProcessAncestry(child.pid, { throughPid: child.pid });
    assert.deepEqual(throughSelf.chain.map(identity => identity.pid), [child.pid]);
    assert.equal(throughSelf.complete, true);
    assert.equal(throughSelf.stoppedBy, "through-pid");
  } finally {
    const closed = once(child, "close");
    child.kill();
    await closed;
  }
  // Outside every supported POSIX PID range; Windows never allocates this odd PID.
  const gonePid = 0x7fffffff;
  if (process.env.PROC_SAFE_TEST_RESTRICTED === "1") {
    assert.throws(() => readProcessAncestry(gonePid), error => error instanceof ProcSafeError
      && error.code === "access-denied" && error.details?.reason === "visibility-policy");
  } else {
    assert.equal(readProcessAncestry(gonePid), null);
  }
  return { checks: 6, stoppedBy: full.stoppedBy };
}
