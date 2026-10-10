import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { closeSync, copyFileSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";

const packageName = "@openclaw/proc-safe";

async function probe(version, target) {
  const require = createRequire(import.meta.url);
  const pkg = require(`${packageName}/package.json`);
  assert.equal(pkg.version, version);
  assert.ok(target.startsWith(`${packageName}-${process.platform}-${process.arch}`), "runtime architecture");
  const fromRoot = createRequire(require.resolve(`${packageName}/package.json`));
  for (const name of Object.keys(pkg.optionalDependencies)) {
    if (name === target) assert.equal(fromRoot(`${name}/package.json`).version, version);
    else assert.throws(() => fromRoot.resolve(name), { code: "MODULE_NOT_FOUND" }, `unexpected platform package ${name}`);
  }
  assert.ok(Object.hasOwn(pkg.optionalDependencies, target), "expected native package is declared");

  const modules = {};
  for (const subpath of Object.keys(pkg.exports)) {
    if (subpath === "./package.json") continue; // Already read above; JSON imports need runtime-specific attributes.
    const name = subpath === "." ? packageName : packageName + subpath.slice(1);
    modules[subpath] = await import(name);
  }
  assert.equal(modules["."].ProcSafeError, modules["./errors"].ProcSafeError);
  const expected = {
    "./identity": true,
    "./darwin": process.platform === "darwin",
    "./inspect": ["darwin", "win32"].includes(process.platform),
    "./windows-job": process.platform === "win32",
    "./reaper": process.platform === "linux",
    "./diagnostics": process.platform === "linux",
    "./test-support": ["linux", "win32"].includes(process.platform),
  };
  for (const [subpath, module] of Object.entries(modules)) {
    if ([".", "./errors"].includes(subpath)) continue;
    assert.equal(typeof module.isSupported, "function", `${subpath}.isSupported`);
    const supported = module.isSupported();
    if (subpath === "./systemd") {
      assert.equal(typeof supported, "boolean");
      if (process.platform !== "linux") assert.equal(supported, false);
    } else {
      assert.equal(supported, expected[subpath], `${subpath}.isSupported`);
    }
  }

  const identity = modules["./identity"].readProcessIdentity(process.pid);
  assert.equal(identity?.pid, process.pid);
  assert.equal(identity.exited, false);
  assert.ok(Number.isSafeInteger(identity.startTimeMicros) && identity.startTimeMicros > 0);
  // Intentionally omit options: the first published release failed walking to launchd.
  const ancestry = modules["./identity"].readProcessAncestry(process.pid);
  assert.ok(Array.isArray(ancestry) && ancestry.length > 0);
  assert.equal(ancestry[0].pid, process.pid);
  assert.ok(ancestry.every(entry => entry.pid > 1));
  if (process.platform === "darwin") {
    const coalition = modules["./darwin"].readProcessCoalition(process.pid);
    assert.ok(coalition && typeof coalition.id === "bigint" && coalition.id > 0n);
  }
  if (["darwin", "win32"].includes(process.platform)) {
    const command = modules["./inspect"].readProcessCommand(process.pid);
    assert.ok(command?.executable && command.argv.length > 0);
    assert.deepEqual(command.environment, {});
  }
  if (process.platform === "win32") {
    // timeoutMs is required; leave all optional census settings at their defaults.
    const rows = modules["./inspect"].listProcesses({ timeoutMs: 5000 });
    assert.ok(rows.some(row => row.pid === process.pid && row.identity?.pid === process.pid && row.owner === "same"));
    assert.equal(typeof modules["./windows-job"].isCurrentProcessInJob(), "boolean");
    const pin = modules["./windows-job"].PinnedProcess.open(process.pid);
    assert.ok(pin);
    try {
      assert.equal(pin.identity.pid, process.pid);
      assert.ok(pin.imagePath.length > 0);
    } finally { pin.close(); }
    assert.equal(typeof modules["./test-support"].hasConsoleWindow(), "boolean");
  }
  if (process.platform === "linux") {
    assert.equal(typeof modules["./reaper"].isChildSubreaper(), "boolean");
    assert.ok(["none", "running", "exited"].includes(modules["./reaper"].inspectChildWaitState().kind));
    const directory = mkdtempSync(join(tmpdir(), "proc-safe-residency-"));
    let fd;
    try {
      const path = join(directory, "sample");
      writeFileSync(path, Buffer.alloc(16384));
      fd = openSync(path, "r");
      // maxPages is required; the operation has no optional settings.
      const sample = modules["./diagnostics"].samplePageCacheResidency(fd, { maxPages: 4 });
      assert.ok(sample.pageSize > 0 && sample.sampledPages > 0 && sample.sampledPages <= 4);
      assert.ok(sample.residentPages >= 0 && sample.residentPages <= sample.sampledPages);
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(directory, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify({ runtime: process.versions.bun ? "bun" : "node", platform: process.platform,
    arch: process.arch, thread: isMainThread ? "main" : "worker", version, target,
    imports: Object.keys(pkg.exports).length, ancestryDepth: ancestry.length, passed: true }));
}

if (!isMainThread) {
  await probe(workerData.version, workerData.target);
  parentPort.postMessage("passed");
} else if (process.argv[2] === "--probe") {
  const [version, target] = process.argv.slice(3);
  await probe(version, target);
  const worker = new Worker(new URL(import.meta.url), { workerData: { version, target } });
  const exit = once(worker, "exit");
  const [message] = await once(worker, "message");
  assert.equal(message, "passed");
  assert.deepEqual(await exit, [0]);
} else {
  const [version, ...args] = process.argv.slice(2);
  assert.match(version ?? "", /^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/, "usage: node scripts/installed-smoke.mjs <exact-version> [--bun] [--tarballs <root.tgz> <platform.tgz>]");
  const withBun = args[0] === "--bun";
  if (withBun) args.shift();
  assert.ok(args.length === 0 || args[0] === "--tarballs" && args.length === 3, "expected root and host platform tarballs");
  const tarballs = args.slice(1).map(path => resolve(path));
  const suffix = process.platform === "win32" ? "-msvc" : process.platform === "linux"
    ? process.report.getReport().header.glibcVersionRuntime ? "-gnu" : "-musl" : "";
  const target = `${packageName}-${process.platform}-${process.arch}${suffix}`;
  const directory = mkdtempSync(join(tmpdir(), "proc-safe-installed-"));
  const env = { ...process.env };
  // A fresh consumer must not inherit workspace resolution, native-mode overrides or npm credentials/config.
  for (const key of Object.keys(env)) {
    if (/^npm_config_/i.test(key) || ["NODE_PATH", "NODE_OPTIONS", "PROC_SAFE_NATIVE", "NPM_TOKEN", "NODE_AUTH_TOKEN"].includes(key)) delete env[key];
  }
  env.npm_config_userconfig = join(directory, "empty-npmrc");
  env.npm_config_globalconfig = join(directory, "empty-global-npmrc");
  env.npm_config_cache = join(directory, "cache");
  try {
    writeFileSync(env.npm_config_userconfig, "");
    writeFileSync(env.npm_config_globalconfig, "");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
    // Copy only this standalone script. All package resolution now starts outside the checkout.
    const script = join(directory, "installed-smoke.mjs");
    copyFileSync(fileURLToPath(import.meta.url), script);
    const installArgs = ["install", ...(tarballs.length ? tarballs : [`${packageName}@${version}`]),
      "--registry=https://registry.npmjs.org", "--no-audit", "--no-fund", "--fetch-retries=0", "--fetch-timeout=30000"];
    const pauses = tarballs.length ? [0] : [0, 5000, 10000, 20000, 40000];
    for (let attempt = 0; attempt < pauses.length; attempt++) {
      await delay(pauses[attempt]);
      try {
        rmSync(join(directory, "node_modules"), { recursive: true, force: true });
        rmSync(join(directory, "package-lock.json"), { force: true });
        // cmd is needed only for npm.cmd; all arguments are fixed, exact versions or trusted local paths.
        execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", installArgs,
          { cwd: directory, env, stdio: "inherit", timeout: 120000, shell: process.platform === "win32" });
        // npm can succeed while an optional platform tarball is still propagating.
        const installed = createRequire(script);
        assert.equal(installed(`${packageName}/package.json`).version, version);
        assert.equal(installed(`${target}/package.json`).version, version);
        break;
      } catch (error) {
        if (attempt === pauses.length - 1) throw error;
        console.error(`Registry install attempt ${attempt + 1} failed; retrying after ${pauses[attempt + 1]}ms`);
      }
    }
    // Behavioral failures are terminal: only registry installation is retried.
    for (const runtime of [process.execPath, ...(withBun ? ["bun"] : [])]) {
      execFileSync(runtime, [script, "--probe", version, target], { cwd: directory, env, stdio: "inherit", timeout: 30000 });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
