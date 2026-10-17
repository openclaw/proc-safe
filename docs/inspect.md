# Process inspection

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
value leaves native code unless its key was requested. POSIX matches names exactly.
Windows uses case-insensitive ordinal comparison and returns keys in the caller's casing;
requesting multiple casing variants returns each requested spelling. Missing keys are omitted,
and empty values are preserved. Names must be nonempty and contain neither
NUL nor `=`. Windows drive-directory pseudo-variables (`=C:`) are excluded by this rule.
No service marker, owner classification, or application policy is implied.

Darwin reads `KERN_PROCARGS2`, validates its returned bounds and argument count, and
retains only requested environment entries. A filled argument buffer throws `incomplete`
because XNU can truncate the string area without reporting a syscall failure. Non-UTF-8 argument or selected environment
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

## Windows process census

```ts
import { listProcesses } from '@openclaw/proc-safe/inspect';

const observations = listProcesses({ timeoutMs: 5000, includeCommand: true });
const sameOwner = observations.filter(row => row.owner === 'same');
```

`listProcesses({ timeoutMs, includeCommand?, pids? })` is Windows-only. Darwin, Linux,
and FreeBSD census calls throw `unsupported-platform`. It returns one frozen
`ProcessSnapshot` per enumerated PID, including inaccessible processes and PIDs that vanish
before their details can be read. Each row has `pid`, `owner` (`'same'`, `'different'`, or
`'unknown'`), optional `identity` (the existing `ProcessIdentity` type), and optional `command`.
Unknown facts never establish absence or ownership. No owner filtering is performed.

`pids` restricts observations to the selected positive platform PIDs. Duplicate selections
produce one row, an empty selection returns an empty array, and selected PIDs absent from
the complete enumeration are omitted. Inaccessible selected processes remain present with
unknown facts. Filtering happens natively before per-process reads; enumeration completeness
and the same deadline still apply. Without `pids`, all enumerated PIDs are returned as before.

Owner comparison uses validated user SIDs from process access tokens. An unreadable token
produces `owner: 'unknown'`. If the caller's own SID is unreadable, all owner comparisons
remain unknown while other row facts are still collected. Identity and command observations use that same retained process
object, avoiding PID reuse between a row's facts. Unreadable or malformed per-process facts
are omitted; the PID remains. `command` is attempted only with `includeCommand: true`, and
its environment is always empty because the census accepts no environment selection.
Without `includeCommand`, only limited process-query access is requested. The returned array
is mutable; rows and nested observations are frozen.

`timeoutMs` is a required positive finite relative duration. A native monotonic clock checks
the budget between observations, and the wrapper also checks the total elapsed time after
result conversion. A synchronous OS call cannot be interrupted; over-budget calls throw on
return. Expiry throws `timeout`, with no partial result. Failed enumeration, duplicate or
malformed PID data, or filling the 65,536-PID buffer throws `incomplete`; a full buffer cannot
prove the absence of additional PIDs. The census is an observation over time, not an atomic
snapshot of every process or an authorization decision.
