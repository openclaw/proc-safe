import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const env = { ...process.env, PROC_SAFE_NATIVE: "require", PROC_SAFE_TEST_RESTRICTED: "1", TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp" };
const probe = fileURLToPath(new URL("./restricted-visibility-proof.mjs", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "proc-safe-restricted-"));
const wrapper = join(directory, "drop-privileges");
try {
  execFileSync("cc", [fileURLToPath(new URL("../test/fixtures/drop-privileges.c", import.meta.url)), "-o", wrapper]);
  if (process.platform === "linux") {
    const preflight = spawnSync("sudo", ["-n", "unshare", "--mount", "--propagation", "private", "true"], { encoding: "utf8" });
    if (preflight.status !== 0) {
      console.log(JSON.stringify({ proof: "restricted-visibility", platform: "linux", available: false, reason: "private mount namespace unavailable", diagnostic: preflight.stderr?.trim() }));
    } else {
      const script = 'mount -t proc -o hidepid=2 proc /proc; export PROC_SAFE_NATIVE=require PROC_SAFE_TEST_RESTRICTED=1; exec "$1" "$2" "$3" "$4"';
      execFileSync("sudo", ["-n", "unshare", "--mount", "--propagation", "private", "sh", "-eu", "-c", script,
        "sh", wrapper, process.execPath, probe, String(process.pid)], { cwd: root, env, stdio: "inherit" });
    }
  } else if (process.platform === "freebsd") {
    if (process.getuid() !== 0) {
      console.log(JSON.stringify({ proof: "restricted-visibility", platform: "freebsd", available: false, reason: "root required to set visibility policy" }));
    } else {
      const name = "security.bsd.see_other_uids";
      const original = execFileSync("sysctl", ["-n", name], { encoding: "utf8" }).trim();
      try {
        execFileSync("sysctl", [`${name}=0`]);
        execFileSync(wrapper, [process.execPath, probe, String(process.pid)], { cwd: root, env, stdio: "inherit" });
      } finally { execFileSync("sysctl", [`${name}=${original}`]); }
    }
  } else { throw new Error("restricted visibility proof is POSIX Linux/FreeBSD only"); }
} finally { rmSync(directory, { recursive: true, force: true }); }
