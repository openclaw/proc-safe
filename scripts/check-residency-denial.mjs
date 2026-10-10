import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "linux");
const directory = mkdtempSync(join(tmpdir(), "proc-safe-residency-denial-"));
try {
  chmodSync(directory, 0o755);
  const file = join(directory, "foreign-readable");
  writeFileSync(file, Buffer.alloc(8192), { mode: 0o444 });
  const wrapper = join(directory, "drop-privileges");
  execFileSync("cc", [fileURLToPath(new URL("../test/fixtures/drop-privileges.c", import.meta.url)), "-o", wrapper]);
  const args = [process.execPath, fileURLToPath(new URL("./residency-denial-proof.mjs", import.meta.url)), file];
  if (process.getuid() === 0) execFileSync(wrapper, args, { stdio: "inherit", timeout: 10000 });
  else execFileSync("sudo", ["-n", wrapper, ...args], { stdio: "inherit", timeout: 10000 });
} finally { rmSync(directory, { recursive: true, force: true }); }
