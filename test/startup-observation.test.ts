import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { formatCallGraph, observeStartup } from "../scripts/startup-observation.mjs";

describe("cold startup observation", () => {
  it("does not sample a child that exits before the observation", async () => {
    let samples = 0;
    const result = await observeStartup(process.execPath, ["-e", ""], {
      sample: async () => { samples++; return { status: "sampled" }; },
      timeoutMs: 5000, sampleDelayMs: 2000,
    });
    expect(result).toMatchObject({ code: 0, timedOut: false, sample: { status: "not-sampled" } });
    expect(samples).toBe(0);
  });

  it("preserves spawn failure without sampling an unknown PID", async () => {
    const result = await observeStartup("proc-safe-fixture-command-that-does-not-exist", [], {
      sample: async () => { throw new Error("must not sample"); },
      timeoutMs: 5000, sampleDelayMs: 1000,
    });
    expect(result).toMatchObject({ spawnError: "ENOENT", timedOut: false, sample: { status: "not-sampled" } });
  });

  it("retains timeout failure and settles an uncooperative child", async () => {
    let samples = 0;
    const result = await observeStartup(process.execPath, ["-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
      sample: async () => { samples++; throw Object.assign(new Error("sample fixture"), { code: "sample-failed" }); },
      timeoutMs: 1500, sampleDelayMs: 500, killGraceMs: 100,
    });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
    expect(result.sample).toEqual({ status: "failed", errorCode: "sample-failed" });
    expect(samples).toBe(1);
    if (process.platform !== "win32") expect(result.signal).toMatch(/^SIG(?:TERM|KILL)$/);
  });

  it("omits sample headers, paths and binary-image inventory", () => {
    const text = "Process: private\nPath: /private/example\nCall graph:\n  1 Thread_1\n    1 wait (/private/example with spaces)\nBinary Images:\n/private/image\n";
    expect(formatCallGraph(text)).toBe("\n  1 Thread_1\n    <path-bearing frame omitted>");
    expect(formatCallGraph("no graph")).toBeNull();
    expect(formatCallGraph("Call graph:\n" + "frame".repeat(10000))?.length).toBeLessThanOrEqual(32768);
  });

  it("keeps termination timers after post-spawn errors until actual exit", async () => {
    vi.useFakeTimers();
    try {
      const signals: string[] = [];
      const child = Object.assign(new EventEmitter(), {
        pid: 1,
        kill: (signal: string) => { signals.push(signal); return false; },
      });
      const observed = observeStartup("fixture", [], {
        spawnChild: () => child, sample: async () => ({ status: "unexpected" }),
        timeoutMs: 20, killGraceMs: 10, sampleDelayMs: 1000,
      });
      let settled = false;
      void observed.then(() => { settled = true; });
      child.emit("spawn");
      child.emit("error", Object.assign(new Error("signal fixture"), { code: "EPERM" }));
      await vi.advanceTimersByTimeAsync(20);
      expect(signals).toEqual(["SIGTERM"]);
      expect(settled).toBe(false);
      child.emit("error", Object.assign(new Error("second fixture"), { code: "EIO" }));
      await vi.advanceTimersByTimeAsync(10);
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(settled).toBe(false);
      child.emit("exit", null, "SIGKILL");
      expect(await observed).toMatchObject({ timedOut: true, signal: "SIGKILL", processErrors: ["EPERM", "EIO"] });
    } finally {
      vi.useRealTimers();
    }
  });
});
