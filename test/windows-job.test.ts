import { execFileSync } from "node:child_process";
import { test, expect } from "vitest";
import { isSupported, WindowsJob, WindowsJobChild, PinnedProcess, isCurrentProcessInJob } from "../src/windows-job.js";

test("resources cannot be fabricated through JavaScript constructors", () => {
  for (const constructor of [WindowsJob, WindowsJobChild, PinnedProcess]) {
    expect(() => Reflect.construct(constructor, [{}])).toThrow(expect.objectContaining({ code: "invalid-argument" }));
  }
});

test("Windows job platform gate", () => {
  expect(typeof isSupported()).toBe("boolean");
  if (process.platform !== "win32") {
    expect(isSupported()).toBe(false);
    for (const run of [() => WindowsJob.create(), () => WindowsJob.open("missing"), () => PinnedProcess.open(process.pid), isCurrentProcessInJob]) {
      expect(run).toThrow(expect.objectContaining({ code: "unsupported-platform" }));
    }
  }
});

test.runIf(process.platform === "win32" && process.env.PROC_SAFE_NATIVE === "require")("real Windows job main-thread, Worker and lifetime boundaries", () => {
  const output = execFileSync(process.execPath, ["scripts/windows-job-proof.mjs"], { encoding: "utf8", timeout: 60_000 });
  expect(JSON.parse(output)).toMatchObject({ platform: "win32", arch: process.arch, passed: 2, lifetimes: 2 });
}, 65_000);

test.runIf(process.platform === "win32" && process.env.PROC_SAFE_NATIVE === "require")("real Windows environment replacement on main thread and Worker", () => {
  const output = execFileSync(process.execPath, ["scripts/windows-job-proof.mjs", "environments"], { encoding: "utf8", timeout: 60_000 });
  expect(JSON.parse(output)).toEqual({ environments: 2 });
}, 65_000);
