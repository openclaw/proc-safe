# Filesystem-restricted launch (Linux)

`@openclaw/proc-safe/filesystem-launch` prepares a native exec wrapper for an
existing process supervisor. It does not spawn, manage children, or restrict the
calling Node process. Imports never load a native addon or start a process.

```js
import { spawn } from "node:child_process";
import { prepareFilesystemRestrictedLaunch } from "@openclaw/proc-safe/filesystem-launch";

const launch = prepareFilesystemRestrictedLaunch({
  executable: process.execPath,
  args: ["/opt/app/worker.mjs"],
  cwd: "/work/session",
  env: { HOME: "/work/session-home", TMPDIR: "/work/session-tmp" },
  readOnlyPaths: ["/usr", "/lib", "/opt/app"],
  readWritePaths: ["/work/session", "/work/session-home", "/work/session-tmp", "/dev/null"],
});
const child = spawn(launch.command, launch.args, {
  env: workerEnvironment,
  stdio: ["pipe", "pipe", "pipe", "ipc"],
});
```

The example paths are application policy, not defaults. Supply the target's
actual executable, libraries, code, trust certificates, scratch and data roots.
Paths must be absolute and exist. Directory grants include their descendants;
file grants apply to that object. A writable tree permits ordinary file,
directory, link, FIFO and socket operations, but not creating device nodes.
An ancestor must itself be granted to permit replacing a granted directory's
name. Grants resolve symlinks when acquired; the caller must protect acquisition
from other writers and validate application-specific root relationships.

The single-threaded helper applies Linux Landlock and `no_new_privs` before
executing the target. It requires Landlock ABI 3 or later, including referral
and truncation restrictions. Missing paths, unsupported kernels and setup errors
exit with status 126 without executing the target. Invalid executable formats
also exit 126, with no shell fallback; valid shebang scripts use their declared
interpreter. There is no unrestricted fallback. The wrapper then becomes the
target: PID, environment, selected
inheritable descriptors and process-group ownership are retained. Optional `env` overrides
apply only to the target after restriction; they do not change the calling process or
the helper's startup environment. Overrides appear in helper arguments; use only
nonsecret values and keep credentials in the caller's explicit IPC or descriptor channel. New target
threads and descendants inherit the restriction.

`prepareFilesystemRestrictedLaunch` validates arguments and resolves the
installed helper. It does not probe the kernel or acquire the grants; those
operations occur during child startup. `PROC_SAFE_NATIVE=off` rejects preparation.
Invalid arguments throw `invalid-argument`. Unsupported platforms and missing helpers throw `ProcSafeError` with
`unsupported-platform` or `helper-unavailable` respectively.

## Boundary and caller responsibilities

This is filesystem access confinement, not a complete process sandbox. The
handled rights cover opening file contents, executing files, listing directories,
creating/removing entries, linking/renaming and truncation. Metadata operations
such as chmod/chown/xattr/time changes, device ioctl, network access, signals and
socket communication need separate controls where the application's threat
model requires them. Existing outer restrictions remain in force.

Already-open descriptors retain their authority. The caller must construct the
inherited descriptor set explicitly, including any IPC, credentials and lineage
channels. Restriction does not revoke descriptors, terminate descendants or
establish exclusive workspace ownership. The existing supervisor remains
responsible for extinction, cleanup and admission after a crash.

Unconfined siblings and trusted helpers are outside this boundary. Applications
relying on stable ancestry must cover every untrusted writer and ensure trusted
services do not execute repository-controlled programs outside their intended
authority. See the [Linux Landlock contract](https://docs.kernel.org/userspace-api/landlock.html).
