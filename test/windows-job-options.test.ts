import { afterEach, expect, test, vi } from "vitest";

vi.mock("../src/native.js", () => ({
  getNativeBinding: () => ({
    createWindowsJob: vi.fn(), openWindowsJob: vi.fn(), openPinnedProcess: vi.fn(), isCurrentProcessInJob: vi.fn(),
  }),
}));
import { spawnWindowsProcess, WindowsJob } from "../src/windows-job.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => Object.defineProperty(process, "platform", platform));

test("Job creation rejects nonboolean breakaway permission", () => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  // @ts-expect-error runtime validation for JavaScript callers
  expect(() => WindowsJob.create({ allowBreakaway: "yes" })).toThrow(expect.objectContaining({ code: "invalid-argument" }));
});

test("breakaway refuses shell execution and unsupported platforms", () => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  expect(() => spawnWindowsProcess("C:\\node.exe", [], { breakawayFromJob: true, shell: true })).toThrow(expect.objectContaining({ code: "invalid-argument", message: expect.stringContaining("shell") }));
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  expect(() => spawnWindowsProcess("node", [], { breakawayFromJob: true })).toThrow(expect.objectContaining({ code: "unsupported-platform" }));
});
