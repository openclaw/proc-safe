# Native architecture

Each capability has an independent TypeScript entry point and a Rust module under native/src.
The common loader selects exactly one matching optional package. It captures the import-time
async context so native registration does not retain the first operation's request scope.
It caches load attempts, never starts child processes, and never downloads or compiles code.
Linux libc detection uses the process report, executable ELF interpreter, then conventional
musl library names. Unknown libc attempts the GNU binding and fails explicitly if incompatible.

Darwin reads public proc_bsdinfo through libc's C layout on both arm64 and x64 and validates
size, PID and timeval fields. Coalitions use PROC_PIDCOALITIONINFO with exact returned-size
checking. Private XPC symbols are resolved only while reading the optional name; all required
symbols, dictionary type, and matching coalition ID are checked before consuming it.

Windows retains a process handle through GetProcessTimes and the parent observation. FILETIME
is divided as a 64-bit integer before conversion to a JavaScript number. Handles close even
when the second observation fails. Access denial is never reported as a missing process.

Linux reads procfs stat using the final comm parenthesis and brackets it with btime reads.
The kernel clock-tick frequency supplies the birth resolution. btime itself is rounded to
seconds: absolute epoch time can differ by up to one second, even though relative birth
resolution is one tick. A clock change during the bracket rejects the observation. A concealed
procfs entry is not absence unless kill(pid, 0) proves ESRCH.

FreeBSD identity is deliberately absent pending a contract decision: the existing consumer
uses a boot-time-bracketed, boot-relative identity to remain stable across wall-clock changes.
An epoch-only API cannot preserve that property. Target packages and VM gates exist; an
unimplemented binding never advertises this capability.

Run `PROC_SAFE_NATIVE=require pnpm test` and `node scripts/runtime-proof.mjs` after building.
Both the main thread and a real Worker query native identities. Packed npm and pnpm root-only
installs test native loading, platform filtering, and Worker behavior outside the workspace.
Run `pnpm benchmark:imports` and `bun scripts/benchmark-imports.mjs` for fresh-process import
measurements. FreeBSD uses system Node; there is no supported Bun binary for FreeBSD.
