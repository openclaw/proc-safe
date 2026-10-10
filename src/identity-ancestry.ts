import type { ProcessAncestry, ProcessIdentity } from "./identity.js";

/** Internal traversal; the caller resolves and validates the starting identity. */
export function walkProcessAncestry(
  self: ProcessIdentity,
  maxDepth: number,
  throughPid: number | undefined,
  readParent: (pid: number) => ProcessIdentity | null,
): ProcessAncestry {
  const chain = [self];
  const seen = new Set([self.pid]);
  function stopped(stoppedBy: ProcessAncestry["stoppedBy"]): ProcessAncestry {
    return Object.freeze({
      chain: Object.freeze(chain),
      complete: ["root", "missing-parent", "recycled-parent", "through-pid"].includes(stoppedBy),
      stoppedBy,
    });
  }
  let current = self;
  for (;;) {
    if (current.pid === throughPid) return stopped("through-pid");
    // Do not query init/launchd, including when the depth limit coincides with the root.
    if (current.parentPid <= 1) return stopped("root");
    if (seen.has(current.parentPid)) return stopped("cycle");
    if (chain.length >= maxDepth) return stopped("max-depth");
    let parent: ProcessIdentity | null;
    try { parent = readParent(current.parentPid); }
    catch { return stopped("unreadable-parent"); }
    if (parent === null) return stopped("missing-parent");
    const sinceBoot = parent.startTimeSinceBootMicros !== undefined && current.startTimeSinceBootMicros !== undefined;
    const parentStart = sinceBoot ? parent.startTimeSinceBootMicros! : parent.startTimeMicros;
    const childStart = sinceBoot ? current.startTimeSinceBootMicros! : current.startTimeMicros;
    if (parentStart > childStart) return stopped("recycled-parent");
    chain.push(parent);
    seen.add(parent.pid);
    current = parent;
  }
}
