import { afterEach, beforeEach, expect, test, vi } from "vitest";

const native = vi.hoisted(() => ({
  create: vi.fn(), bind: vi.fn(), spawn: vi.fn(), resolve: vi.fn(),
  owner: { bindLifetime: vi.fn(), close: vi.fn() },
  job: { close: vi.fn() },
}));
vi.mock("../src/native.js", () => ({
  getNativeBinding: () => ({
    createWindowsJob: native.create,
    openWindowsJob: vi.fn(),
    openPinnedProcess: () => native.owner,
    isCurrentProcessInJob: () => false,
  }),
  validatePid: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: native.spawn }));
vi.mock("node:module", () => ({ createRequire: () => ({ resolve: native.resolve }) }));
import { bindCurrentProcessLifetimeTo, PinnedProcess, spawnWindowsProcess, WindowsJob } from "../src/windows-job.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  native.create.mockReturnValue(native.job);
  native.resolve.mockReturnValue("/native/proc-safe-native.node");
});
afterEach(() => Object.defineProperty(process, "platform", platform));

test("Job creation and lifetime binding require explicit breakaway permission", () => {
  WindowsJob.create();
  WindowsJob.create({ allowBreakaway: true });
  expect(native.create.mock.calls).toEqual([[undefined, true, false], [undefined, true, true]]);
  const owner = PinnedProcess.open(process.pid, { access: "lifetime-owner" })!;
  bindCurrentProcessLifetimeTo(owner);
  bindCurrentProcessLifetimeTo(owner, { allowBreakaway: true });
  expect(native.owner.bindLifetime.mock.calls).toEqual([[false], [true]]);
  expect(() => WindowsJob.create({ allowBreakaway: "yes" as unknown as boolean })).toThrow(expect.objectContaining({ code: "invalid-argument" }));
});

test("explicit breakaway preserves caller stdio and environment through the native launcher", () => {
  const stdio = ["pipe", "pipe", 7, "ipc"] as const;
  const env = { KEEP_ME: "synthetic" };
  spawnWindowsProcess("C:\\node.exe", ["", "a b", "extra"], { breakawayFromJob: true, stdio: [...stdio], env, detached: true, cwd: "C:\\work" });
  expect(native.spawn).toHaveBeenCalledExactlyOnceWith("/native/proc-safe-spawn.exe", ["quoted", "C:\\node.exe", "C:\\node.exe", "", "a b", "extra"], {
    stdio: [...stdio], env, detached: true, cwd: "C:\\work", argv0: undefined, windowsVerbatimArguments: false,
  });
});

test("default spawn delegates unchanged without a Windows binding or launcher", () => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const options = { stdio: "pipe" as const, env: { KEEP_ME: "synthetic" } };
  spawnWindowsProcess("node", ["--version"], options);
  expect(native.spawn).toHaveBeenCalledExactlyOnceWith("node", ["--version"], options);
  expect(native.resolve).not.toHaveBeenCalled();
});

test("breakaway refuses unsupported platforms and shell execution", () => {
  expect(() => spawnWindowsProcess("C:\\windows\\cmd.exe", [], { breakawayFromJob: true, shell: true })).toThrow(expect.objectContaining({ code: "invalid-argument", message: expect.stringContaining("shell") }));
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  expect(() => spawnWindowsProcess("node", [], { breakawayFromJob: true })).toThrow(expect.objectContaining({ code: "unsupported-platform" }));
  expect(native.spawn).not.toHaveBeenCalled();
});
