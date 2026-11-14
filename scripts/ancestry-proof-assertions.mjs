import assert from "node:assert/strict";

export function assertDefaultAncestry(ancestry, pid) {
  assert.ok(ancestry !== null);
  assert.ok(Array.isArray(ancestry.chain) && ancestry.chain.length > 0 && ancestry.chain.length <= 32);
  assert.equal(ancestry.chain[0].pid, pid);
  assert.ok(ancestry.chain.every(identity => identity.pid > 1));
  assert.equal(new Set(ancestry.chain.map(identity => identity.pid)).size, ancestry.chain.length);
  const reasons = { root: true, "missing-parent": true, "recycled-parent": true,
    cycle: false, "max-depth": false, "unreadable-parent": false };
  assert.ok(Object.hasOwn(reasons, ancestry.stoppedBy), `invalid default stop reason: ${ancestry.stoppedBy}`);
  assert.equal(ancestry.complete, reasons[ancestry.stoppedBy]);
  const last = ancestry.chain.at(-1);
  if (ancestry.stoppedBy === "root") assert.ok(last.parentPid <= 1);
  if (ancestry.stoppedBy === "max-depth") assert.equal(ancestry.chain.length, 32);
  if (ancestry.stoppedBy === "cycle") assert.ok(ancestry.chain.some(identity => identity.pid === last.parentPid));
}
