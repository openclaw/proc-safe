# Native architecture

Each capability has an independent TypeScript entry point and a Rust module under native/src.
The [systemd capability](systemd.md) loads `libsystemd.so.0` lazily through `dlopen`,
with no link-time dependency. Each connection's dedicated native thread owns its
bus, messages, credentials, and cleanup. N-API asynchronous tasks deliver owned
results; no sd-bus work or caller callbacks execute on the JavaScript thread.
The common loader selects exactly one matching optional package. It captures the import-time
async context so native registration does not retain the first operation's request scope.
It caches load attempts, never starts child processes, and never downloads or compiles code.
Linux libc detection uses the process report, executable ELF interpreter, then conventional
musl library names. Unknown libc attempts the GNU binding and fails explicitly if incompatible.

Darwin reads public proc_bsdinfo through libc's C layout on both arm64 and x64 and validates
size, PID and timeval fields. Its ESRCH path checks `kern.proc.pid` using the SDK
layout because libproc excludes zombies. This second observation distinguishes
a retained zombie from a missing object. Coalitions use PROC_PIDCOALITIONINFO with exact returned-size
checking. Private XPC symbols are resolved only while reading the optional name; all required
symbols, dictionary type, and matching coalition ID are checked before consuming it.

Windows retains a process handle through GetProcessTimes and the parent observation. FILETIME
is divided as a 64-bit integer before conversion to a JavaScript number. Handles close even
when an observation fails. GetExitCodeProcess reports retained exited objects; an exit timestamp disambiguates
the reserved STILL_ACTIVE value from an application that actually exits with code 259. Access denial is never reported as a missing process.

Linux reads procfs stat using the final comm parenthesis and brackets it with btime reads.
The kernel clock-tick frequency supplies the birth resolution. btime itself is rounded to
seconds: absolute epoch time can differ by up to one second, even though relative birth
resolution is one tick. `startTimeSinceBootMicros` comes directly from start ticks
and is preferred for PID-reuse comparisons. Zombie/dead states set `exited`. A clock change during the bracket rejects the observation. A concealed
procfs entry is not absence unless kill(pid, 0) proves ESRCH.

FreeBSD reads `kern.proc.pid` using libc's kinfo_proc layout, requiring 1088 bytes,
layout version zero, and the requested PID. Exact boot timevals bracket the query;
a changed bracket fails closed. `startTimeMicros` is the kernel epoch start time;
`startTimeSinceBootMicros` subtracts that same bracketed boot timeval. `ki_stat`
identifies zombies. Visibility denial can also return ESRCH. A cached policy snapshot determines whether
that means absence or `access-denied` with a `visibility-policy` reason. Policy
read failures are restricted. See [identity and visibility](identity.md).

FreeBSD CI uses 14.4. Dependencies and TypeScript output are prepared on Linux and
synced into the VM; Cargo builds the addon under the FreeBSD kernel. The portable
native suite runs directly with Node, including the unreaped-zombie test and real
Workers, followed by a root-only npm consumer install. ARM64 CPU execution uses
QEMU emulation with a real FreeBSD kernel. No pnpm binary runs inside either VM.

Run `PROC_SAFE_NATIVE=require pnpm test` and `node scripts/runtime-proof.mjs` after building.
`node scripts/p2-proof.mjs` exercises page-cache observations and test-only fixtures on
the main thread and real Workers. Linux seccomp proof runs in disposable child processes.
Page-cache sampling uses one bounded `PROT_NONE` mapping at a time and always unmaps
through Rust. Windows raw-spawn fixtures are independent of production launch owners,
disable handle inheritance, and close their process/thread handles in Rust.
Linux reaping uses non-consuming `waitid` observations and PID-specific `waitpid`,
both with `__WALL`; it never performs a reap-any-child operation. The Node-only
`scripts/reaper-proof.mjs` runs dedicated owners on the main thread and a Worker,
including a non-SIGCHLD clone child retained across exec, adopted grandchildren,
and libuv-owned Node children whose exit events must retain their real status.
Both the main thread and a real Worker query native identities. Packed npm and pnpm root-only
installs test native loading, platform filtering, and Worker behavior outside the workspace.
Run `pnpm benchmark:imports` and `bun scripts/benchmark-imports.mjs` for fresh-process import
measurements. FreeBSD uses system Node; there is no supported Bun binary for FreeBSD.

Command [inspection](inspect.md) uses Darwin `KERN_PROCARGS2` and Windows PEB parameters,
including WOW64 layouts. Bounds and returned lengths are validated in Rust. Only requested
environment entries cross N-API. Windows memory reads use one retained process handle;
Darwin checks translation in Rust and refuses Rosetta before reading argument data.
