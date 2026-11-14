import { expect, test } from "vitest";
import { walkProcessAncestry } from "../src/identity-ancestry.js";
import { assertDefaultAncestry } from "../scripts/ancestry-proof-assertions.mjs";

const identity = (pid: number, parentPid: number) => ({
  pid, parentPid, startTimeMicros: pid, startTimeResolutionMicros: 1, exited: false,
});

test("native and installed proofs accept an explicit cycle without claiming completeness", () => {
  const ancestry = walkProcessAncestry(identity(3, 2), 32, undefined, () => identity(2, 3));
  expect(ancestry).toMatchObject({ complete: false, stoppedBy: "cycle" });
  expect(() => assertDefaultAncestry(ancestry, 3)).not.toThrow();
});

test("native and installed proofs accept the default depth limit", () => {
  const ancestry = walkProcessAncestry(identity(34, 33), 32, undefined, pid => identity(pid, pid - 1));
  expect(ancestry).toMatchObject({ complete: false, stoppedBy: "max-depth" });
  expect(ancestry.chain).toHaveLength(32);
  expect(() => assertDefaultAncestry(ancestry, 34)).not.toThrow();
});

test("proofs reject an incomplete reason labeled complete or an unknown reason", () => {
  const chain = [identity(3, 3)];
  expect(() => assertDefaultAncestry({ chain, complete: true, stoppedBy: "cycle" }, 3)).toThrow();
  expect(() => assertDefaultAncestry({ chain, complete: false, stoppedBy: "unknown" }, 3)).toThrow();
});

test("proofs reject cycle and depth reasons inconsistent with the observed chain", () => {
  const chain = [identity(3, 2)];
  expect(() => assertDefaultAncestry({ chain, complete: false, stoppedBy: "cycle" }, 3)).toThrow();
  expect(() => assertDefaultAncestry({ chain, complete: false, stoppedBy: "max-depth" }, 3)).toThrow();
});
