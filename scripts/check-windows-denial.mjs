import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { readProcessIdentity } from "../dist/identity.js";
import { hostNativeTarget } from "./native-targets.mjs";

const helper = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
  fileURLToPath(new URL("../test/fixtures/windows-denied-process.ps1", import.meta.url)),
  "-NodePath", process.execPath], { stdio: ["pipe", "pipe", "inherit"] });
const closed = once(helper, "close");
try {
  const lines = createInterface({ input: helper.stdout })[Symbol.asyncIterator]();
  const pid = Number((await lines.next()).value);
  assert.equal(readProcessIdentity(pid).exited, false);
  helper.stdin.write("deny\n");
  assert.equal((await lines.next()).value, "denied");
  const target = hostNativeTarget();
  const fixture = fileURLToPath(new URL(`../target/${target.rust}/release/proc-safe-restricted-fixture.exe`, import.meta.url));
  execFileSync(fixture, [process.execPath, fileURLToPath(new URL("./permission-denial-proof.mjs", import.meta.url)), String(pid)], { stdio: "inherit" });
} finally {
  helper.stdin.end("release\n");
  assert.deepEqual(await closed, [0, null]);
}
console.log("controlled process ACL denial verified on main and Worker");
