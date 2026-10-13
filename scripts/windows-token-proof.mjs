import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { isSupported, readCurrentAppContainerSid } from "../dist/windows-token.js";
import { ProcSafeError } from "../dist/errors.js";
import { hostNativeTarget, nativePackageDirectory } from "./native-targets.mjs";

function observe(mode, expected) {
  if (mode === "disabled" || process.platform !== "win32") {
    assert.equal(isSupported(), false);
    assert.throws(readCurrentAppContainerSid, error => error instanceof ProcSafeError &&
      error.code === (process.platform === "win32" ? "helper-unavailable" : "unsupported-platform"));
    return "unavailable";
  }
  assert.equal(isSupported(), true);
  if (mode === "denied") {
    assert.throws(readCurrentAppContainerSid, error => error instanceof ProcSafeError && error.code === "access-denied");
    return "access-denied";
  }
  assert.equal(readCurrentAppContainerSid(), expected);
  assert.equal(readCurrentAppContainerSid(), expected);
  return expected;
}

async function both(mode, expected, directory) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { mode, expected } });
  const exited = once(worker, "exit");
  let result = once(worker, "message");
  if (mode === "denied") {
    assert.deepEqual(await result, ["ready"]);
    writeFileSync(join(directory, "ready"), "ready");
    const start = performance.now();
    while (!existsSync(join(directory, "go"))) {
      assert.ok(performance.now() - start < 25_000, "token denial controller did not respond");
      await delay(10);
    }
    result = once(worker, "message");
    worker.postMessage("query");
  }
  const main = observe(mode, expected);
  const [fromWorker] = await result;
  assert.equal(fromWorker, main);
  assert.deepEqual(await exited, [0]);
  return { main, worker: fromWorker };
}

if (!isMainThread) {
  if (workerData.mode === "denied") {
    randomBytes(1);
    assert.equal(isSupported(), true);
    parentPort.postMessage("ready");
    await once(parentPort, "message");
  }
  parentPort.postMessage(observe(workerData.mode, workerData.expected));
} else if (process.argv[2] === "--contained") {
  try {
    const result = await both("contained", process.argv[3]);
    writeFileSync("result.json", JSON.stringify(result));
  } catch (error) {
    writeFileSync("error.txt", error.stack ?? String(error));
    process.exitCode = 1;
  }
} else if (process.argv[2] !== undefined && process.argv[2] !== "--disabled") {
  randomBytes(1);
  assert.equal(isSupported(), true);
  await both("denied", undefined, process.argv[2]);
} else if (process.argv[2] === "--disabled") {
  console.log(JSON.stringify(await both("disabled")));
} else {
  const outside = await both("outside", null);
  execFileSync(process.execPath, [fileURLToPath(new URL(import.meta.url)), "--disabled"], {
    env: { ...process.env, PROC_SAFE_NATIVE: "off" }, timeout: 10_000,
  });
  let contained;
  if (process.platform === "win32") {
    const target = hostNativeTarget();
    const fixture = fileURLToPath(new URL(`../target/${target.rust}/release/proc-safe-appcontainer-fixture.exe`, import.meta.url));
    const directory = mkdtempSync(join(tmpdir(), "proc-safe-appcontainer-"));
    try {
      const runtime = join(directory, "runtime.exe");
      copyFileSync(process.execPath, runtime);
      cpSync(new URL("../dist", import.meta.url), join(directory, "dist"), { recursive: true });
      cpSync(new URL("../package.json", import.meta.url), join(directory, "package.json"));
      const scripts = join(directory, "scripts");
      mkdirSync(scripts);
      copyFileSync(fileURLToPath(new URL(import.meta.url)), join(scripts, "windows-token-proof.mjs"));
      copyFileSync(fileURLToPath(new URL("./native-targets.mjs", import.meta.url)), join(scripts, "native-targets.mjs"));
      const packagePath = join(directory, "node_modules", target.package);
      cpSync(nativePackageDirectory(target), packagePath, { recursive: true });
      let expected;
      try {
        expected = execFileSync(fixture, [runtime, join(scripts, "windows-token-proof.mjs"), directory], {
          encoding: "utf8", timeout: 35_000,
        }).trim();
      } catch (error) {
        const detail = join(directory, "error.txt");
        if (existsSync(detail)) error.message += `\nAppContainer child: ${readFileSync(detail, "utf8")}`;
        throw error;
      }
      assert.match(expected, /^S-1-15-2-/);
      contained = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
      assert.deepEqual(contained, { main: expected, worker: expected });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    const deniedDirectory = mkdtempSync(join(tmpdir(), "proc-safe-token-denied-"));
    try {
      const denial = fileURLToPath(new URL(`../target/${target.rust}/release/proc-safe-restricted-fixture.exe`, import.meta.url));
      execFileSync(denial, [process.execPath, fileURLToPath(new URL(import.meta.url)), deniedDirectory, "--deny-token"], {
        timeout: 35_000,
      });
    } finally {
      rmSync(deniedDirectory, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch,
    runtime: process.versions.bun ? "bun" : "node", outside, contained, passed: process.platform === "win32" ? 4 : 2 }));
}
