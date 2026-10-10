# Command inspection

`@openclaw/proc-safe/inspect` reads a process's executable and exact argument boundaries
on native Darwin arm64/x64 and Windows arm64/x64. The subpath imports on all platforms
without loading native code. `isSupported()` never throws; it returns false on unsupported
platforms, when the binding is unavailable or disabled, and under Rosetta.

```ts
import { readProcessCommand } from '@openclaw/proc-safe/inspect';

const command = readProcessCommand(process.pid, {
  environmentKeys: ['MY_APPLICATION_INSTANCE'],
});
```

`readProcessCommand(pid, { environmentKeys? })` returns a frozen `ProcessCommand`, or
`null` when the process is proven gone. The argument array and environment record are
also frozen. An empty or omitted `environmentKeys` returns an empty record; no environment
value leaves native code unless its exact, case-sensitive key was requested. Missing keys
are omitted, and empty values are preserved. Names must be nonempty and contain neither
NUL nor `=`. Windows drive-directory pseudo-variables (`=C:`) are excluded by this rule.
No service marker, owner classification, or application policy is implied.

Darwin reads `KERN_PROCARGS2`, validates its returned bounds and argument count, and
retains only requested environment entries. Non-UTF-8 argument or selected environment
bytes throw `layout-mismatch`, since the public API consists of JavaScript strings.
If XNU appends Apple startup metadata without a separating environment boundary,
inspection with requested environment keys throws `incomplete`; metadata is never returned
as an environment value. A `pfz=` entry at that aligned boundary is ambiguous even if
a caller placed it in the environment. Rosetta is refused in Rust with `unsupported-platform` and a diagnostic recommending a
native arm64 runtime. Native x64 on Intel is supported.

Windows retains a process handle while reading the image path and PEB process parameters.
It validates information lengths, PID, string lengths, pointer arithmetic, and both native
64-bit and WOW64 32-bit layouts. `executable` is the kernel-reported image path. `commandLine`
is the raw UTF-16 command line and `argv` uses Windows `CommandLineToArgvW` parsing rules.
`cwd` is Windows-only. Requested environment entries are scanned through readable memory
regions with a 1 MiB bound; exceeding the bound throws `incomplete`. An omitted environment
selection avoids reading the environment entirely.

A snapshot can race with changes made by the target process: these observations do not pin
its mutable command, working directory, or environment. Access denial, malformed layouts,
unreadable memory, retained exited objects without readable arguments, and incomplete data
throw `ProcSafeError`, never an empty command or a false absence. There is no shell fallback.
