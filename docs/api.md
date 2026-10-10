# API

`@openclaw/proc-safe/identity` exports:

```ts
type ProcessIdentity = {
  readonly pid: number;
  readonly parentPid: number;
  readonly startTimeMicros: number;
  readonly startTimeResolutionMicros: number;
};
function readProcessIdentity(pid: number): ProcessIdentity | null;
function readProcessAncestry(pid: number, options?: { maxDepth?: number }): ProcessIdentity[];
function isSupported(): boolean;
```

PIDs must be positive integers representable by the OS. `maxDepth` is a positive safe
integer, defaults to 32, and counts self. The walk stops at PID 0/1, a missing process,
a cycle, or the depth limit. A parent born after its child is a reused PID and is excluded.
Observations are fresh, including foreign processes. An identity is a snapshot, not a
retained process handle. Permission failures throw, even partway through ancestry.

`@openclaw/proc-safe/darwin` exports:

```ts
type DarwinCoalition = { readonly id: bigint; readonly name?: string };
function readProcessCoalition(pid: number): DarwinCoalition | null;
function isSupported(): boolean;
```

A zero resource-coalition ID or a proven missing process returns `null`. Missing private
XPC symbols only omit the optional name; failure of the kernel observation throws.
No service-membership policy is applied. Private XPC availability is not guaranteed.

The root and `./errors` export `ProcSafeError` and `ProcSafeErrorCode`. Errors accept
`(code, message, { cause?, details? })`. Stable codes are `unsupported-platform`,
`helper-unavailable`, `access-denied`, `layout-mismatch`, `timeout`, `incomplete`,
`invalid-argument`, and `operation-failed`. `details` is optional diagnostic context.
