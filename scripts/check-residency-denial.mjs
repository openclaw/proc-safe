import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostNativeTarget } from "./native-targets.mjs";

assert.equal(process.platform, "linux");
const directory = mkdtempSync(join(tmpdir(), "proc-safe-residency-denial-"));
try {
  chmodSync(directory, 0o755);
  // The runner's checkout can be below a private home. Only public package
  // files and this synthetic probe enter the unprivileged workspace.
  const workspace = join(directory, "workspace");
  mkdirSync(workspace, { mode: 0o755 });
  for (const name of ["dist", "package.json"]) {
    cpSync(new URL(`../${name}`, import.meta.url), join(workspace, name), { recursive: true });
  }
  const target = hostNativeTarget();
  assert.ok(target);
  const packagePath = join(workspace, "packages", target.label);
  cpSync(new URL(`../packages/${target.label}`, import.meta.url), packagePath, { recursive: true });
  const scope = join(workspace, "node_modules", "@openclaw");
  mkdirSync(scope, { recursive: true });
  symlinkSync(packagePath, join(scope, `proc-safe-${target.label}`));
  const scripts = join(workspace, "scripts");
  mkdirSync(scripts);
  const probe = join(scripts, "residency-denial-proof.mjs");
  cpSync(new URL("./residency-denial-proof.mjs", import.meta.url), probe);
  const file = join(directory, "foreign-readable");
  writeFileSync(file, Buffer.alloc(8192), { mode: 0o444 });
  const wrapper = join(directory, "drop-privileges");
  execFileSync("cc", [fileURLToPath(new URL("../test/fixtures/drop-privileges.c", import.meta.url)), "-o", wrapper]);
  const args = [process.execPath, probe, file];
  if (process.getuid() === 0) execFileSync(wrapper, args, { cwd: workspace, stdio: "inherit", timeout: 10000 });
  else execFileSync("sudo", ["-n", wrapper, ...args], { cwd: workspace, stdio: "inherit", timeout: 10000 });
} finally { rmSync(directory, { recursive: true, force: true }); }
