import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

async function observe(url, probe) {
  const { getProcSafeNativeStatus } = await import(url);
  const before = await getProcSafeNativeStatus();
  const after = await getProcSafeNativeStatus({ probe });
  assert.deepEqual(await getProcSafeNativeStatus(), after);
  return { before, after };
}

if (!isMainThread) {
  parentPort.postMessage(await observe(workerData.url, workerData.probe));
} else if (process.argv.includes("--observe")) {
  const url = process.argv.at(-1);
  const main = await observe(url, true);
  const worker = new Worker(new URL(import.meta.url), { workerData: { url, probe: true } });
  const exited = once(worker, "exit");
  const [result] = await once(worker, "message");
  assert.deepEqual(result, main);
  assert.deepEqual(await exited, [0]);
  console.log(JSON.stringify(main));
} else {
  const url = new URL("../dist/index.js", import.meta.url).href;
  const observations = [];
  function check(entry, reason, loaded = false) {
    assert.equal(entry.after.reason, reason);
    assert.equal(entry.after.loaded, loaded);
    assert.equal(entry.after.modeSource, "PROC_SAFE_NATIVE");
    for (const value of Object.values(entry.after)) {
      if (typeof value === "string") assert.ok(!value.includes("PRIVATE_SENTINEL"));
    }
    observations.push(reason);
  }
  function child(entryUrl, mode, runner = import.meta.url) {
    return JSON.parse(execFileSync(process.execPath, [...(process.versions.bun ? ["--no-install"] : []), fileURLToPath(runner), "--observe", entryUrl], {
      encoding: "utf8", env: { ...process.env, PROC_SAFE_NATIVE: mode }, timeout: 10_000,
      cwd: dirname(fileURLToPath(runner)),
    }));
  }
  const off = child(url, "off");
  check(off, "disabled");
  assert.equal(off.before.reason, "disabled");
  if (process.env.PROC_SAFE_NATIVE === "require") {
    const real = child(url, "require");
    check(real, "loaded", true);
    assert.equal(real.before.reason, "not-probed");
    assert.equal(real.after.packageVersion, JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version);
  }
  const directory = mkdtempSync(join(tmpdir(), "proc-safe-status-"));
  try {
    cpSync(new URL("../dist", import.meta.url), join(directory, "dist"), { recursive: true });
    cpSync(new URL("../package.json", import.meta.url), join(directory, "package.json"));
    cpSync(new URL(import.meta.url), join(directory, "observer.mjs"));
    const runner = pathToFileURL(join(directory, "observer.mjs"));
    const isolatedUrl = pathToFileURL(join(directory, "dist/index.js")).href;
    const missing = child(isolatedUrl, "require", runner);
    check(missing, "package-missing");
    assert.equal(missing.before.reason, "not-probed");
    assert.equal(missing.after.loadErrorCode, undefined);
    const packagePath = join(directory, "node_modules", missing.after.packageName);
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(join(packagePath, "package.json"), JSON.stringify({ main: "index.cjs" }));
    for (const [source, reason, code] of [
      ['require("PRIVATE_SENTINEL_missing_dependency")', "load-failed", "MODULE_NOT_FOUND"],
      ['throw Object.assign(new Error("PRIVATE_SENTINEL/path"), { code: "ERR_DLOPEN_FAILED" })', "load-failed", "ERR_DLOPEN_FAILED"],
      ['throw Object.assign(new Error("PRIVATE_SENTINEL/path"), { code: "PRIVATE_SENTINEL/code" })', "load-failed", "UNKNOWN"],
      ['throw { get code() { throw new Error("PRIVATE_SENTINEL"); } }', "load-failed", "UNKNOWN"],
      ['module.exports = {}', "capability-missing", undefined],
    ]) {
      writeFileSync(join(packagePath, "index.cjs"), source);
      const observation = child(isolatedUrl, "require", runner);
      check(observation, reason);
      assert.equal(observation.after.loadErrorCode, code);
      assert.equal(observation.before.reason, "not-probed");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ platform: process.platform, runtime: process.versions.bun ? "bun" : "node", contexts: ["main", "worker"], observations }));
}
