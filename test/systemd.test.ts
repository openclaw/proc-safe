import { execFileSync } from "node:child_process";
import { describe, test, expect } from "vitest";
import { SystemdBus, isSupported } from "../src/systemd.js";

describe("systemd contracts", () => {
  test("invalid arguments are typed", async () => {
    for (const timeoutMs of [0, -1, NaN, Infinity]) {
      await expect(SystemdBus.connectBroker("unix:path=/missing", { timeoutMs })).rejects.toMatchObject({ code: "invalid-argument" });
    }
    await expect(SystemdBus.connectPrivatePeer("bad\0address", { timeoutMs: 1 })).rejects.toMatchObject({ code: "invalid-argument" });
  });
  test("unsupported hosts retain import and factory shape", async () => {
    expect(typeof isSupported()).toBe("boolean");
    if (process.platform === "linux") return;
    expect(isSupported()).toBe(false);
    for (const factory of ["connectBroker", "connectUserManager", "connectPrivatePeer", "connectMachineBroker"] as const) {
      await expect(SystemdBus[factory]("address", { timeoutMs: 1 })).rejects.toMatchObject({ code: "unsupported-platform" });
    }
  });
  test("off never loads native code", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      process.dlopen = () => { throw new Error('native loading forbidden'); };
      const { SystemdBus, isSupported } = await import('./dist/systemd.js');
      if (isSupported()) throw new Error('off advertised support');
      try { await SystemdBus.connectBroker('unix:path=/missing', { timeoutMs: 1 }); throw new Error('succeeded'); }
      catch (e) { if (!['helper-unavailable', 'unsupported-platform'].includes(e.code)) throw e; }
      console.log('off');
    `], { encoding: "utf8", env: { ...process.env, PROC_SAFE_NATIVE: "off" } });
    expect(output.trim()).toBe("off");
  });
  test.runIf(process.env.PROC_SAFE_SYSTEMD_PROOF === "1").each(["main", "worker", "flood", "worker-flood"])("real systemd boundary: %s", scenario => {
    const output = execFileSync(process.execPath, ["scripts/systemd-proof.mjs", scenario], { encoding: "utf8", timeout: 20_000 });
    const result = JSON.parse(output);
    expect(result.scenario).toBe(scenario);
    expect(result.passed).toBeGreaterThan(35);
    if (scenario.endsWith("flood")) expect(result.signals).toBe(401_408);
  });
  test.runIf(process.env.PROC_SAFE_SYSTEMD_NO_LIBRARY === "1")("Alpine imports without libsystemd", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { createRequire } from 'node:module';
      import { Worker } from 'node:worker_threads';
      import { once } from 'node:events';
      const binding = createRequire(import.meta.url)('@openclaw/proc-safe-linux-' + process.arch + '-musl');
      if (typeof binding.systemdSupported !== 'function') throw new Error('missing compiled capability');
      const { isSupported, SystemdBus } = await import('./dist/systemd.js');
      if (isSupported()) throw new Error('libsystemd unexpectedly present');
      try { await SystemdBus.connectBroker('unix:path=/missing', { timeoutMs: 50 }); throw new Error('succeeded'); }
      catch (e) { if (e.code !== 'helper-unavailable') throw e; }
      const moduleUrl = new URL('./dist/systemd.js', import.meta.url).href;
      const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(
        'import { parentPort } from "node:worker_threads"; const { isSupported, SystemdBus } = await import(' + JSON.stringify(moduleUrl) + '); if (isSupported()) throw new Error("unexpected support"); try { await SystemdBus.connectBroker("unix:path=/missing", { timeoutMs: 50 }); throw new Error("succeeded"); } catch(e) { if (e.code !== "helper-unavailable") throw e; } parentPort.postMessage("no-libsystemd");'
      )));
      const ended = once(worker, 'exit');
      const [message] = await once(worker, 'message');
      const [code] = await ended;
      if (message !== 'no-libsystemd' || code !== 0) throw new Error('Worker proof failed');
      console.log('no-libsystemd');
    `], { encoding: "utf8" });
    expect(output.trim()).toBe("no-libsystemd");
  });
});
