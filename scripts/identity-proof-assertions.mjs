import assert from "node:assert/strict";
import { readProcessIdentity } from "../dist/identity.js";

export function assertSameIdentity(actual, expected) {
  if (process.platform !== "linux") return assert.deepEqual(actual, expected);
  const { startTimeMicros: actualEpoch, ...actualStable } = actual;
  const { startTimeMicros: expectedEpoch, ...expectedStable } = expected;
  assert.deepEqual(actualStable, expectedStable);
  // Epoch is sampled at read time; the boot-relative birth remains exact.
  assert.ok(Math.abs(actualEpoch - expectedEpoch) <= 2 * actual.startTimeResolutionMicros + 1);
}

export function readAfterClose(pid, before) {
  let result;
  try { result = readProcessIdentity(pid); }
  catch (error) {
    assert.equal(process.env.PROC_SAFE_TEST_RESTRICTED, "1", "default CI must prove the permissive branch");
    assert.equal(error.code, "access-denied");
    assert.deepEqual(error.details, { reason: "visibility-policy" });
    return { restricted: true };
  }
  if (result !== null) {
    assert.equal(result.exited, true);
    assert.equal(result.pid, before.pid);
    if (process.platform !== "linux") assert.equal(result.startTimeMicros, before.startTimeMicros);
    assert.equal(result.startTimeSinceBootMicros, before.startTimeSinceBootMicros);
  }
  return { result };
}
