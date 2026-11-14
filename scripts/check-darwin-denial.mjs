import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.platform !== "darwin") throw new Error("Darwin sandbox required");
// Deny both identity sources; libproc denial alone can leave a valid kernel record.
execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)(deny process-info*)(deny sysctl-read (sysctl-name-prefix \"kern.proc\"))",
  process.execPath, fileURLToPath(new URL("./permission-denial-proof.mjs", import.meta.url)), String(process.pid)],
{ stdio: "inherit", env: { ...process.env, PROC_SAFE_NATIVE: "require" } });

execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)(deny process-info*)(deny sysctl-read (sysctl-name-prefix \"kern.proc\"))(allow process-info* (target self))",
  process.execPath, fileURLToPath(new URL("./ancestry-denial-proof.mjs", import.meta.url))],
{ stdio: "inherit", env: { ...process.env, PROC_SAFE_NATIVE: "require" } });

execFileSync(process.execPath, [fileURLToPath(new URL("./inspect-denial-proof.mjs", import.meta.url))],
  { stdio: "inherit", env: { ...process.env, PROC_SAFE_NATIVE: "require" } });
