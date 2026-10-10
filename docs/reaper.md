# Linux child ownership and reaping

```ts
import {
  becomeChildSubreaper, isChildSubreaper, inspectChildWaitState, reapChild,
} from '@openclaw/proc-safe/reaper';

becomeChildSubreaper();
const enabled = isChildSubreaper();
const state = inspectChildWaitState(adoptedPid);
if (state.kind === 'exited') {
  const exit = reapChild(state.pid);
}
```

The application must coordinate all child owners in the process. Enabling subreaping
is a process-wide setting, including when called from a Worker. Enable it before
launching children in a dedicated owner process. It does not retroactively transfer
already-adopted processes. This package reports kernel facts; it does not discover
ownership policy, schedule cleanup, retry waits, or decide which children to signal.
The real ownership proof uses Node and its libuv child registry. Applications that
currently gate their subreaper on Node must retain that gate; Bun ownership semantics
are not established by this API's importability or `isSupported()` result.

`inspectChildWaitState(pid?)` never reaps. It uses `waitid` with `WNOWAIT`, `WNOHANG`,
`WEXITED`, and `__WALL`, including non-SIGCHLD children and children created by another
thread in the process. With a positive PID it observes only that PID; without a PID
it observes all children. Its frozen result is:

- `{ kind: 'none' }`: `ECHILD`. With a PID, it is not our unreaped child; without a
  PID, no children remain. This does not mean that a supplied PID does not exist.
- `{ kind: 'running' }`: waitable children exist but none has an exit status available.
  This includes children that are stopped or otherwise not executing.
- `{ kind: 'exited', pid }`: an exited child whose status is still retained.

An inspection is an observation, not a retained handle. Keep ownership coordinated:
another thread or library can otherwise reap between inspection and a following
signal or reap. In particular, **never pass a libuv-owned child to `reapChild`**.
The caller must select an owned adopted child and inspect it before reaping.
There is no reap-any-child operation.

`reapChild(pid)` uses nonblocking `waitpid` with `__WALL` for exactly one positive PID.
It returns `null` while that child has no exit status, or a frozen
`{ pid, exitCode, signal }` with one of `exitCode` and `signal` null. `ECHILD` throws
`ProcSafeError` with code `operation-failed` and `details: { reason: 'not-a-child' }`.
That includes reaping an already-reaped PID. Exit signals outside `NodeJS.Signals`
(Linux real-time signals) throw `layout-mismatch` before consuming the status.

All PIDs must be positive platform integers; zero and negative group selectors are
rejected. Linux GNU/musl x64 and arm64 are supported. Imports remain lazy everywhere;
unsupported platforms throw `unsupported-platform`, and missing or disabled native
bindings throw `helper-unavailable`. `isSupported()` tests platform and binding
availability without throwing. System-call failures remain typed errors.
