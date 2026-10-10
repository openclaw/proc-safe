import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { readProcessIdentity } from "../dist/identity.js";
import { hostNativeTarget } from "./native-targets.mjs";

const helper = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
  fileURLToPath(new URL("../test/fixtures/windows-denied-process.ps1", import.meta.url)),
  "-NodePath", process.execPath], { stdio: ["pipe", "pipe", "inherit"] });
const closed = once(helper, "close");
const failures = [];
try {
  const lines = createInterface({ input: helper.stdout })[Symbol.asyncIterator]();
  const pidLine = (await lines.next()).value;
  assert.match(pidLine ?? "", /^\d+$/, "fixture must report only its PID");
  const pid = Number(pidLine);
  assert.ok(Number.isInteger(pid) && pid > 0, "fixture must report a valid PID");
  assert.equal(readProcessIdentity(pid).exited, false);
  helper.stdin.write("deny\n");
  assert.equal((await lines.next()).value, "denied");
  const target = hostNativeTarget();
  const fixture = fileURLToPath(new URL(`../target/${target.rust}/release/proc-safe-restricted-fixture.exe`, import.meta.url));
  execFileSync(fixture, [process.execPath, fileURLToPath(new URL("./permission-denial-proof.mjs", import.meta.url)), String(pid)], { stdio: "inherit" });
} catch (error) {
  failures.push(error);
} finally {
  helper.stdin.end("release\n");
  try { assert.deepEqual(await closed, [0, null]); }
  catch (error) { failures.push(error); }
}
if (failures.length) throw new AggregateError(failures, "Windows denial proof failed");
console.log("controlled process ACL denial verified on main and Worker");
const tokenFixture = fileURLToPath(new URL(`../target/${hostNativeTarget().rust}/release/proc-safe-restricted-fixture.exe`, import.meta.url));
const tokenDirectory = mkdtempSync(join(tmpdir(), "proc-safe-token-denial-"));
try {
  execFileSync(tokenFixture, [process.execPath, fileURLToPath(new URL("./census-token-denial-proof.mjs", import.meta.url)), tokenDirectory, "--deny-token"], { stdio: "inherit" });
} finally { rmSync(tokenDirectory, { recursive: true, force: true }); }
