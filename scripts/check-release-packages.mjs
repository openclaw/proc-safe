import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { nativeTargets, hostNativeTarget, nativePackageDirectory } from "./native-targets.mjs";
import { resolveNpmCli } from "./npm-cli.mjs";
import { normalizePackResult } from "./npm-pack-result.mjs";
import { startConsumerRegistry } from "./consumer-registry.mjs";

const run = promisify(execFile);
const npm = resolveNpmCli();
const output = resolve("release-artifacts");
mkdirSync(output, { recursive: true });
const rootPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const host = hostNativeTarget();
assert.ok(host, "host must be a supported release target");
const targets = process.argv.includes("--allow-host-only") ? [host] : nativeTargets;
const manifest = [];
const artifacts = [];
const managers = process.argv.includes("--npm-only") ? ["npm"] : ["npm", "pnpm"];
function pack(directory) {
  const pkg = JSON.parse(readFileSync(new URL("package.json", directory), "utf8"));
  const result = JSON.parse(execFileSync(process.execPath, [npm, "pack", "--ignore-scripts", "--json", "--pack-destination", output], { cwd: directory, encoding: "utf8" }));
  const normalized = normalizePackResult(result, pkg.name);
  const raw = Array.isArray(result) ? result[0] : result[pkg.name];
  const entry = { name: pkg.name, version: pkg.version, filename: normalized.filename, integrity: raw.integrity, size: raw.size };
  assert.ok(entry.integrity && entry.size > 0);
  manifest.push(entry);
  artifacts.push({ pkg, tarball: join(output, entry.filename), integrity: entry.integrity });
}
for (const target of targets) {
  const directory = nativePackageDirectory(target);
  assert.ok(existsSync(new URL("proc-safe-native.node", directory)), `missing binary ${target.label}`);
  pack(directory);
}
pack(new URL("../", import.meta.url));
writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
const registry = await startConsumerRegistry(artifacts);
const temp = mkdtempSync(join(tmpdir(), "proc-safe-consumer-"));
try {
  const env = { ...process.env, npm_config_registry: registry.registry, npm_config_userconfig: join(temp, "empty-npmrc"), npm_config_globalconfig: join(temp, "empty-global-npmrc"), npm_config_cache: join(temp, "cache") };
  for (const key of ["NODE_PATH", "NODE_OPTIONS", "NPM_TOKEN", "NODE_AUTH_TOKEN", "npm_config__authToken"]) delete env[key];
  writeFileSync(env.npm_config_userconfig, "");
  writeFileSync(env.npm_config_globalconfig, "");
  for (const manager of managers) {
    const cwd = join(temp, manager);
    mkdirSync(cwd);
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ private: true, type: "module" }));
    const args = ["install", `@openclaw/proc-safe@${rootPackage.version}`, "--ignore-scripts", "--registry", registry.registry];
    if (manager === "npm") args.push("--no-audit", "--no-fund");
    const command = manager === "npm" ? process.execPath : process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    await run(command, manager === "npm" ? [npm, ...args] : args, { cwd, env, timeout: 120_000, shell: manager === "pnpm" && process.platform === "win32" });
    const proof = `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { readProcessIdentity, isSupported } from '@openclaw/proc-safe/identity';
      import * as darwin from '@openclaw/proc-safe/darwin';
      import * as systemd from '@openclaw/proc-safe/systemd';
      const require = createRequire(import.meta.url);
      assert.ok(isSupported());
      assert.equal(readProcessIdentity(process.pid).pid, process.pid);
      assert.equal(darwin.isSupported(), process.platform === 'darwin');
      assert.equal(typeof systemd.SystemdBus.connectPrivatePeer, 'function');
      assert.equal(typeof systemd.isSupported(), 'boolean');
      if (process.platform !== 'linux') assert.equal(systemd.isSupported(), false);
      const root = require.resolve('@openclaw/proc-safe/package.json');
      const fromRoot = createRequire(root);
      for (const name of ${JSON.stringify(nativeTargets.map(t => t.package))}) {
        if (name === ${JSON.stringify(host.package)}) assert.ok(fromRoot.resolve(name));
        else assert.throws(() => fromRoot.resolve(name));
      }
      const { Worker } = await import('node:worker_threads');
      const { once } = await import('node:events');
      const worker = new Worker(new URL('./worker.mjs', import.meta.url));
      const exit = once(worker, 'exit');
      const [pid] = await once(worker, 'message');
      assert.equal(pid, process.pid);
      assert.deepEqual(await exit, [0]);
    `;
    writeFileSync(join(cwd, "proof.mjs"), proof);
    writeFileSync(join(cwd, "worker.mjs"), "import { parentPort } from 'node:worker_threads'; import { readProcessIdentity } from '@openclaw/proc-safe/identity'; import { SystemdBus, isSupported } from '@openclaw/proc-safe/systemd'; if (typeof SystemdBus.connectBroker !== 'function' || typeof isSupported() !== 'boolean') throw new Error('systemd import failed'); parentPort.postMessage(readProcessIdentity(process.pid).pid);\n");
    await run(process.execPath, ["proof.mjs"], { cwd, env: { ...env, PROC_SAFE_NATIVE: "require" }, timeout: 30_000 });
    console.log(`${manager} root-only install: native main + Worker + platform filtering passed`);
  }
  writeFileSync(join(output, "consumer-proof.json"), JSON.stringify({ platform: process.platform, arch: process.arch, target: host.label, packages: manifest, managers, passed: true }, null, 2) + "\n");
} finally {
  await registry.close();
  rmSync(temp, { recursive: true, force: true });
}
