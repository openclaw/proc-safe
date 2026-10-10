import { test, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishReleasePackages } from "../scripts/publish-release-packages.mjs";
import { nativeTargets } from "../scripts/native-targets.mjs";

test("all ten platforms verify before root, with at most two in flight", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proc-safe-release-"));
  const complete: string[] = [];
  let active = 0;
  let maximum = 0;
  try {
    await writeFile(join(dir, "manifest.json"), JSON.stringify([{ name: "@openclaw/proc-safe" }, ...nativeTargets.map(t => ({ name: t.package }))]));
    await publishReleasePackages({ artifactsDir: dir, publish: async ({ packageName }) => {
      if (packageName === "@openclaw/proc-safe") expect(complete).toHaveLength(10);
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setImmediate(resolve));
      complete.push(packageName);
      active--;
    } });
    expect(maximum).toBe(2);
    expect(complete.at(-1)).toBe("@openclaw/proc-safe");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a failed platform prevents root publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proc-safe-release-"));
  const calls: string[] = [];
  try {
    await writeFile(join(dir, "manifest.json"), JSON.stringify([{ name: "@openclaw/proc-safe" }, ...nativeTargets.map(t => ({ name: t.package }))]));
    await expect(publishReleasePackages({ artifactsDir: dir, publish: async ({ packageName }) => {
      calls.push(packageName);
      throw new Error("verification failed");
    } })).rejects.toThrow("verification failed");
    expect(calls).not.toContain("@openclaw/proc-safe");
    expect(calls).toHaveLength(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
