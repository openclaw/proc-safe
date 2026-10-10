import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { readProcessIdentity } from "../dist/identity.js";

export async function proveLinuxEpoch(executable) {
  const observations = [];
  for (let sample = 0; sample < 32; sample++) {
    const earliest = Date.now() * 1000;
    const child = spawn(executable, ["hold"], { stdio: ["ignore", "pipe", "inherit"] });
    const closed = once(child, "close");
    try {
      await once(child.stdout, "data");
      const latest = Date.now() * 1000;
      const identity = readProcessIdentity(child.pid);
      const clocks = JSON.parse(execFileSync(executable, { encoding: "utf8" }));
      const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
      const ticks = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19]);
      assert.equal(identity.startTimeSinceBootMicros, Math.floor(ticks * 1_000_000 / clocks.hz));
      assert.equal(identity.startTimeResolutionMicros, 1_000_000 / clocks.hz);
      // One tick for procfs birth truncation, one for the bounded clock sample,
      // and 1 ms for Date.now() truncation. This is independent of btime's fraction.
      const tolerance = 2 * identity.startTimeResolutionMicros + 1000;
      assert.ok(identity.startTimeMicros >= earliest - tolerance, JSON.stringify({ earliest, latest, identity, clocks }));
      assert.ok(identity.startTimeMicros <= latest + tolerance, JSON.stringify({ earliest, latest, identity, clocks }));
      const again = readProcessIdentity(child.pid);
      assert.equal(again.startTimeSinceBootMicros, identity.startTimeSinceBootMicros);
      observations.push({ earliest, latest, identity, clocks, ticks });
    } finally {
      child.kill();
      await closed;
    }
  }
  return observations;
}
