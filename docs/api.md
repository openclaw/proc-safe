# API

`@openclaw/proc-safe/windows-token` exports [current-process AppContainer facts](windows-token.md):

```ts
function isSupported(): boolean;
function readCurrentAppContainerSid(): string | null;
```

The root exports [`getProcSafeNativeStatus(options?)`](native-status.md) and its
status types for optional, path-free native health checks.

See [systemd connections](systemd.md) for the Linux `./systemd` subpath, typed
messages, connection ownership, and deadline and authentication contracts.

See [Windows jobs](windows-job.md) for `@openclaw/proc-safe/windows-job` (including opt-in breakaway spawning with inherited stdio):
`WindowsJob`, `WindowsJobChild`, `PinnedProcess`, `WindowsJobSpawnOptions`,
`isCurrentProcessInJob`, `retainCurrentProcessJobUntilExit`,
`bindCurrentProcessLifetimeTo`, and `isSupported`.

`@openclaw/proc-safe/identity` exports:

```ts
type ProcessIdentity = {
  readonly pid: number;
  readonly parentPid: number;
  readonly startTimeMicros: number;
  readonly startTimeResolutionMicros: number;
  readonly startTimeSinceBootMicros?: number;
  readonly exited: boolean;
};
function readProcessIdentity(pid: number): ProcessIdentity | null;
type ProcessAncestry = {
  readonly chain: readonly ProcessIdentity[];
  readonly complete: boolean;
  readonly stoppedBy: "root" | "missing-parent" | "recycled-parent" | "cycle" | "max-depth" | "through-pid" | "unreadable-parent";
};
function readProcessAncestry(pid: number, options?: { maxDepth?: number; throughPid?: number }): ProcessAncestry | null;
function isSupported(): boolean;
```

`startTimeSinceBootMicros` is present on Linux and FreeBSD and absent on Darwin and
Windows. Compare boot-relative times when both identities provide them; use epoch
times otherwise. `exited` describes a zombie or a retained Windows process object;
it does not erase the object's birth identity. `null` means no kernel object exists.

PIDs must be positive integers representable by the OS. Ancestry starts with `pid <= 1`
throw `invalid-argument` with `details: { reason: "init-process" }` before any native read;
`readProcessIdentity(1)` is unchanged. `maxDepth` is a positive safe
integer and defaults to 32. `maxDepth` counts the starting process.
`throughPid`, when supplied, must be a valid
PID and stops the walk after including that process. The chain is self-first and
never reads PID 0 or 1. A parent born after its child is a reused PID
and is excluded. `complete` is true only for `root`, `missing-parent`, `recycled-parent`,
or `through-pid`; `cycle`, `max-depth`, and `unreadable-parent` are incomplete.
Only failure to identify the starting process throws; a proven missing start returns
`null`. Parent read failures preserve the observed chain with `unreadable-parent`.
Observations are fresh, including foreign processes. An identity is a snapshot, not a
retained process handle.
See [identity and visibility](identity.md) for policy-aware absence results.

`@openclaw/proc-safe/darwin` exports:

```ts
type DarwinCoalition = { readonly id: bigint; readonly name?: string };
function readProcessCoalition(pid: number): DarwinCoalition | null;
function isSupported(): boolean;
```

A zero resource-coalition ID or a proven missing process returns `null`. Missing private
XPC symbols only omit the optional name; failure of the kernel observation throws.
No service-membership policy is applied. Private XPC availability is not guaranteed.

`@openclaw/proc-safe/reaper` exports [Linux child ownership and reaping](reaper.md):

```ts
type ChildWaitState =
  | { readonly kind: "none" }
  | { readonly kind: "running" }
  | { readonly kind: "exited"; readonly pid: number };
type ChildExit = {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly signalNumber: number | null;
};
function becomeChildSubreaper(): void;
function isChildSubreaper(): boolean;
function inspectChildWaitState(pid?: number): ChildWaitState;
function reapChild(pid: number): ChildExit | null;
function isSupported(): boolean;
```

`@openclaw/proc-safe/diagnostics` exports [Linux page-cache observations](diagnostics.md):

```ts
type PageCacheResidency = {
  readonly pageSize: number;
  readonly sampledPages: number;
  readonly residentPages: number;
};
function samplePageCacheResidency(fd: number, options: { maxPages: number }): PageCacheResidency;
function isSupported(): boolean;
```

`@openclaw/proc-safe/test-support` exports [test-only native fixtures](test-support.md)
for Linux group-kill denial and raw Windows launches/console observation.

The root and `./errors` export `ProcSafeError` and `ProcSafeErrorCode`. Errors accept
`(code, message, { cause?, details? })`. Stable codes are `unsupported-platform`,
`helper-unavailable`, `access-denied`, `layout-mismatch`, `timeout`, `incomplete`,
`invalid-argument`, and `operation-failed`. `details` is optional diagnostic context;
capability-specific documented fields, including the [systemd ownership-refusal
reason and UIDs](systemd.md#factories-and-identity), are stable public contracts.

`@openclaw/proc-safe/inspect` exports the [command inspection API](inspect.md):

```ts
type ProcessCommand = {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly commandLine?: string;
  readonly cwd?: string;
  readonly environment: Readonly<Record<string, string>>;
};
function readProcessCommand(pid: number, options?: { environmentKeys?: readonly string[] }): ProcessCommand | null;
type ProcessState = "running" | "sleeping" | "stopped" | "zombie" | "idle" | "unknown";
type ProcessSnapshot = {
  readonly pid: number;
  readonly parentPid?: number;
  readonly identity?: ProcessIdentity;
  readonly owner: "same" | "different" | "unknown";
  readonly command?: ProcessCommand;
  readonly processGroupId?: number;
  readonly state?: ProcessState;
};
function listProcesses(options: { timeoutMs: number; includeCommand?: boolean; pids?: readonly number[] }): ProcessSnapshot[];
function isSupported(): boolean;
```
