import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { prepareFilesystemRestrictedLaunch } from "../dist/filesystem-launch.js";

async function prove() {
  const root = mkdtempSync(join(tmpdir(), "proc-safe-filesystem-"));
  const workspace = join(root, "workspace");
  const privateRoot = join(root, "private");
  mkdirSync(workspace);
  mkdirSync(privateRoot);
  // Same-UID baseline: ancestry is writable before the child restriction.
  renameSync(workspace, workspace + "-baseline");
  renameSync(workspace + "-baseline", workspace);
  const canary = join(privateRoot, "canary");
  const inherited = join(privateRoot, "inherited-capability");
  writeFileSync(canary, "unchanged");
  const target = join(root, "target.mjs");
  writeFileSync(target, `
    import assert from 'node:assert/strict';
    import { writeFileSync, renameSync, readFileSync, createReadStream } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    const [root, workspace, privateRoot] = process.argv.slice(2, 5);
    assert.equal(process.env.PROC_SAFE_LAUNCH_TEST, 'target=only');
    assert.equal(process.cwd(), workspace);
    assert.throws(() => renameSync(workspace, root + '/replaced'), { code: 'EACCES' });
    assert.throws(() => renameSync(privateRoot, root + '/redirected'), { code: 'EACCES' });
    assert.throws(() => writeFileSync(privateRoot + '/canary', 'changed'), { code: 'EACCES' });
    writeFileSync(workspace + '/created', 'allowed');
    renameSync(workspace + '/created', workspace + '/renamed');
    assert.equal(readFileSync(workspace + '/renamed', 'utf8'), 'allowed');
    if (process.argv[5] !== 'descendant') {
      let input = '';
      for await (const chunk of createReadStream('', { fd: 3 })) input += chunk;
      assert.equal(input, 'explicit-input');
      // Deliberately inherited writable handles are capabilities, not revoked by Landlock.
      writeFileSync(5, 'explicit-capability');
      execFileSync(process.execPath, [process.argv[1], root, workspace, privateRoot, 'descendant']);
      process.stdout.write('stdout-preserved');
      process.stderr.write('stderr-preserved');
      process.send({ pid: process.pid, env: process.env.PROC_SAFE_LAUNCH_TEST }, () => process.disconnect());
    }
  `);
  const options = {
    executable: process.execPath,
    args: [target, root, workspace, privateRoot],
    cwd: workspace,
    env: { PROC_SAFE_LAUNCH_TEST: "target=only" },
    readOnlyPaths: [process.execPath, "/usr", "/lib", "/lib64", "/etc/ld.so.cache", "/etc/ssl", "/etc/pki", "/proc", root].filter(existsSync),
    readWritePaths: [workspace, "/dev/null"],
  };
  let child;
  try {
    const parentValue = process.env.PROC_SAFE_LAUNCH_TEST;
    const launch = prepareFilesystemRestrictedLaunch(options);
    const fd = openSync(inherited, "w");
    try {
      child = spawn(launch.command, launch.args, { stdio: ["pipe", "pipe", "pipe", "pipe", "ipc", fd] });
    } finally { closeSync(fd); }
    const closed = once(child, "close");
    const message = once(child, "message");
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    // An early setup failure may close the input pipe before its write completes.
    child.stdio[3].on("error", () => {});
    child.stdio[3].end("explicit-input");
    child.stdin.end();
    const [code, signal] = await closed;
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);
    assert.deepEqual((await message)[0], { pid: child.pid, env: "target=only" });
    assert.equal(stdout, "stdout-preserved");
    assert.equal(stderr, "stderr-preserved");
    assert.equal(process.env.PROC_SAFE_LAUNCH_TEST, parentValue);
    assert.equal(readFileSync(canary, "utf8"), "unchanged");
    assert.equal(readFileSync(inherited, "utf8"), "explicit-capability");
    const marker = join(workspace, "must-not-start");
    const denied = prepareFilesystemRestrictedLaunch({ ...options,
      args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'started')", marker],
      readOnlyPaths: [...options.readOnlyPaths, join(root, "missing-grant")],
    });
    child = spawn(denied.command, denied.args, { stdio: ["ignore", "pipe", "pipe"] });
    const failed = once(child, "close");
    child.stdout.resume();
    child.stderr.resume();
    assert.deepEqual(await failed, [126, null]);
    assert.equal(existsSync(marker), false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill();
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

await prove();
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  const closed = once(worker, "exit");
  const message = once(worker, "message");
  assert.deepEqual(await message, ["passed"]);
  assert.deepEqual(await closed, [0]);
  console.log("filesystem launch: main and Worker passed");
} else parentPort.postMessage("passed");
