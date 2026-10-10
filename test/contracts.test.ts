import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { ProcSafeError } from "../src/errors.js";
import { readProcessIdentity, readProcessAncestry } from "../src/identity.js";
import { readProcessCoalition } from "../src/darwin.js";

describe("public contracts", () => {
  test.each([0, -1, 1.5, NaN, Infinity, 0x1_0000_0000])("rejects invalid PID %s", pid => {
    expect(() => readProcessIdentity(pid)).toThrow(ProcSafeError);
    expect(() => readProcessIdentity(pid)).toThrow(expect.objectContaining({ code: "invalid-argument" }));
  });
  test.each([0, -1, 1.5, NaN, Infinity])("rejects invalid ancestry depth %s", maxDepth => {
    expect(() => readProcessAncestry(process.pid, { maxDepth })).toThrow(expect.objectContaining({ code: "invalid-argument" }));
  });
  test("every subpath imports without loading a binding or spawning a process", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      process.dlopen = () => { throw new Error('addon was loaded during import'); };
      process.env.PROC_SAFE_NATIVE = 'require';
      for (const name of ['index', 'errors', 'identity', 'darwin', 'reaper', 'diagnostics', 'test-support', 'systemd']) await import('./dist/' + name + '.js');
      console.log('lazy');
    `], { encoding: "utf8" });
    expect(output.trim()).toBe("lazy");
  });
  test("off never advertises native capabilities and operations fail explicitly", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      const identity = await import('./dist/identity.js');
      const darwin = await import('./dist/darwin.js');
      if (identity.isSupported() || darwin.isSupported()) throw new Error('off advertised support');
      try { identity.readProcessIdentity(process.pid); throw new Error('succeeded'); }
      catch (e) { if (e.code !== 'helper-unavailable' && e.code !== 'unsupported-platform') throw e; }
      console.log('off');
    `], { encoding: "utf8", env: { ...process.env, PROC_SAFE_NATIVE: "off" } });
    expect(output.trim()).toBe("off");
  });
  test("Darwin calls throw on other platforms", () => {
    if (process.platform === "darwin") { expect(process.platform).toBe("darwin"); return; }
    expect(() => readProcessCoalition(process.pid)).toThrow(expect.objectContaining({ code: "unsupported-platform" }));
  });
});
