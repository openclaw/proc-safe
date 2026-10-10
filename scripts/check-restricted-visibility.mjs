import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, cpSync, mkdirSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostNativeTarget } from "./native-targets.mjs";

const root = new URL("../", import.meta.url);
const env = { ...process.env, PROC_SAFE_NATIVE: "require", PROC_SAFE_TEST_RESTRICTED: "1", TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp" };

const directory = mkdtempSync(join(tmpdir(), "proc-safe-restricted-"));
const wrapper = join(directory, "drop-privileges");
try {
  // Only public package code and synthetic fixtures enter the unprivileged workspace.
  chmodSync(directory, 0o755);
  const workspace = join(directory, "workspace");
  mkdirSync(workspace, { mode: 0o755 });
  for (const name of ["dist", "scripts", "test/fixtures", "package.json"]) {
    cpSync(new URL(name, root), join(workspace, name), { recursive: true });
  }
  const target = hostNativeTarget();
  const packagePath = join(workspace, "packages", target.label);
  cpSync(new URL(`packages/${target.label}`, root), packagePath, { recursive: true });
  const scope = join(workspace, "node_modules", "@openclaw");
  mkdirSync(scope, { recursive: true });
  symlinkSync(packagePath, join(scope, `proc-safe-${target.label}`));
  const probe = join(workspace, "scripts", "restricted-visibility-proof.mjs");
  execFileSync("cc", [fileURLToPath(new URL("../test/fixtures/drop-privileges.c", import.meta.url)), "-o", wrapper]);
  if (process.platform === "linux") {
    const preflight = spawnSync("sudo", ["-n", "unshare", "--mount", "--propagation", "private", "true"], { encoding: "utf8" });
    if (preflight.status !== 0) {
      console.log(JSON.stringify({ proof: "restricted-visibility", platform: "linux", available: false, reason: "private mount namespace unavailable", diagnostic: preflight.stderr?.trim() }));
    } else {
      const script = 'mount -t proc -o hidepid=2 proc /proc; export PROC_SAFE_NATIVE=require PROC_SAFE_TEST_RESTRICTED=1; exec "$1" "$2" "$3" "$4"';
      execFileSync("sudo", ["-n", "unshare", "--mount", "--propagation", "private", "sh", "-eu", "-c", script,
        "sh", wrapper, process.execPath, probe, String(process.pid)], { cwd: workspace, env, stdio: "inherit" });
    }
  } else if (process.platform === "freebsd") {
    if (process.getuid() !== 0) {
      console.log(JSON.stringify({ proof: "restricted-visibility", platform: "freebsd", available: false, reason: "root required to set visibility policy" }));
    } else {
      const name = "security.bsd.see_other_uids";
      const original = execFileSync("sysctl", ["-n", name], { encoding: "utf8" }).trim();
      try {
        execFileSync("sysctl", [`${name}=0`]);
        execFileSync(wrapper, [process.execPath, probe, String(process.pid)], { cwd: workspace, env, stdio: "inherit" });
      } finally { execFileSync("sysctl", [`${name}=${original}`]); }
    }
  } else { throw new Error("restricted visibility proof is POSIX Linux/FreeBSD only"); }
} finally { rmSync(directory, { recursive: true, force: true }); }
