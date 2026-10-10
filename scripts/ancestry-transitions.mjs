import assert from "node:assert/strict";
import { walkProcessAncestry } from "../dist/identity-ancestry.js";
import { ProcSafeError } from "../dist/errors.js";

// Pure traversal fixtures supplement the real-kernel suite; no native binding is mocked.
export function proveAncestryTransitions() {
  const identity = (pid, parentPid, startTimeMicros, startTimeSinceBootMicros) => Object.freeze({
    pid, parentPid, startTimeMicros, startTimeResolutionMicros: 1, exited: false,
    ...(startTimeSinceBootMicros === undefined ? {} : { startTimeSinceBootMicros }),
  });
  const self = identity(30, 20, 300);
  const parent = identity(20, 10, 200);
  const root = identity(10, 1, 100);
  let checks = 0;
  const verify = (start, records, maxDepth, throughPid, stoppedBy, pids, reads) => {
    const queried = [];
    const result = walkProcessAncestry(start, maxDepth, throughPid, pid => {
      assert.ok(pid > 1, "never read PID 0 or 1");
      queried.push(pid);
      const record = records.get(pid);
      if (record instanceof Error) throw record;
      return record ?? null;
    });
    assert.deepEqual(result.chain.map(item => item.pid), pids);
    assert.deepEqual(queried, reads);
    assert.equal(result.stoppedBy, stoppedBy);
    assert.equal(result.complete, ["root", "missing-parent", "recycled-parent", "through-pid"].includes(stoppedBy));
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.chain));
    checks++;
  };
  const records = new Map([[20, parent], [10, root]]);
  verify(self, records, 32, undefined, "root", [30, 20, 10], [20, 10]);
  verify(identity(10, 0, 100), records, 1, undefined, "root", [10], []);
  verify(root, records, 1, undefined, "root", [10], []);
  verify(self, new Map(), 32, undefined, "missing-parent", [30], [20]);
  verify(self, records, 1, undefined, "max-depth", [30], []);
  verify(self, records, 2, undefined, "max-depth", [30, 20], [20]);
  verify(self, records, 3, undefined, "root", [30, 20, 10], [20, 10]);
  verify(self, records, 1, 30, "through-pid", [30], []);
  verify(self, records, 2, 20, "through-pid", [30, 20], [20]);
  verify(self, records, 3, 10, "through-pid", [30, 20, 10], [20, 10]);
  verify(self, records, 32, 999, "root", [30, 20, 10], [20, 10]);
  verify(identity(30, 30, 300), records, 1, undefined, "cycle", [30], []);
  verify(self, new Map([[20, identity(20, 30, 200)]]), 32, undefined, "cycle", [30, 20], [20]);
  verify(self, new Map([[20, identity(20, 10, 301)]]), 32, 20, "recycled-parent", [30], [20]);
  // Boot-relative identity wins when wall-clock observations disagree.
  verify(identity(30, 20, 300, 30), new Map([[20, identity(20, 1, 400, 20)]]), 32, undefined, "root", [30, 20], [20]);
  verify(identity(30, 20, 300, 30), new Map([[20, identity(20, 1, 200, 40)]]), 32, undefined, "recycled-parent", [30], [20]);
  verify(self, new Map([[20, identity(20, 1, 300)]]), 32, undefined, "root", [30, 20], [20]);
  for (const code of ["access-denied", "layout-mismatch", "incomplete", "helper-unavailable", "unsupported-platform", "operation-failed", "timeout", "invalid-argument"]) {
    verify(self, new Map([[20, new ProcSafeError(code, "parent is unknown", { details: { reason: "visibility-policy" } })]]), 32, undefined, "unreadable-parent", [30], [20]);
  }
  return checks;
}
