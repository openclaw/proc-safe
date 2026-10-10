import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { readProcessIdentity } from "../dist/identity.js";
import { provePermissionDenied } from "./permission-denial-proof.mjs";

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
  await provePermissionDenied(pid);
} finally {
  helper.stdin.end("release\n");
  assert.deepEqual(await closed, [0, null]);
}
console.log("controlled process ACL denial verified on main and Worker");
