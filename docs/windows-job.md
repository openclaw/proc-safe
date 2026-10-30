# Windows jobs

`@openclaw/proc-safe/windows-job` imports on every platform without loading native code.
`isSupported()` reports whether the Windows x64/ARM64 binding is available. Operations
on other platforms throw `ProcSafeError` with `unsupported-platform`; absent or disabled
bindings throw `helper-unavailable`. Native failures map to the same typed error family.

```ts
import { WindowsJob } from '@openclaw/proc-safe/windows-job';

using job = WindowsJob.create();
using child = job.spawn({
  executable: process.execPath,
  commandLine: `"${process.execPath}" -e "console.log('hello')"`,
});
// Poll in the caller's scheduling loop; an empty Buffer means no bytes available now.
const bytes = child.readStdout(65536);
const code = child.exitCode(); // null while running, otherwise the unsigned exit code
const { activeProcesses } = job.accounting();
```

## API

```ts
type WindowsJobSpawnOptions = {
  readonly executable: string;
  readonly commandLine: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
};
class WindowsJob implements Disposable {
  static create(options?: { name?: string; killOnJobClose?: boolean; allowBreakaway?: boolean }): WindowsJob;
  static open(name: string): WindowsJob | null;
  assignCurrentProcess(): void;
  assignProcess(target: PinnedProcess): void;
  spawn(options: WindowsJobSpawnOptions): WindowsJobChild;
  processIds(): number[];
  accounting(): { readonly activeProcesses: number; readonly totalProcesses: number; readonly terminatedProcesses: number };
  terminate(exitCode: number): void;
  close(): void;
  [Symbol.dispose](): void;
}
class WindowsJobChild implements Disposable {
  readonly pid: number;
  readStdout(maxBytes: number): Buffer | null;
  readStderr(maxBytes: number): Buffer | null;
  exitCode(): number | null;
  close(): void;
  [Symbol.dispose](): void;
}
class PinnedProcess implements Disposable {
  static open(pid: number, options?: { expect?: { imagePath?: string; startTimeMicros?: number }; access?: "observe" | "lifetime-owner" | "job-member" }): PinnedProcess | null;
  readonly identity: ProcessIdentity;
  readonly imagePath: string;
  readonly access: "observe" | "lifetime-owner" | "job-member";
  close(): void;
  [Symbol.dispose](): void;
}
function isCurrentProcessInJob(): boolean;
function retainCurrentProcessJobUntilExit(job: WindowsJob): void;
function bindCurrentProcessLifetimeTo(owner: PinnedProcess, options?: { allowBreakaway?: boolean }): void;
type WindowsProcessSpawnOptions = SpawnOptions & { readonly breakawayFromJob?: boolean };
function spawnWindowsProcess(command: string, args: readonly string[], options?: WindowsProcessSpawnOptions): ChildProcess;
function isSupported(): boolean;
```

`ProcessIdentity` is the existing [identity type](identity.md). The pinned getter reads the
retained kernel handle afresh, including `exited`; it never reopens a PID. Image and birth
expectations must match exactly or throw `operation-failed`. Only a proven missing process
returns null. Expectations belong in `options.expect` (the former second positional
expectation object is no longer supported). Image/ancestry selection and authorization
policy remain in the caller.

Choose `options.access` for the intended operation; it defaults to `"observe"` and is
available as the readonly `access` property. Each pin requests exactly these process rights:

| Access | Rights | Mask | Intended use |
| --- | --- | --- | --- |
| `"observe"` | QUERY_LIMITED_INFORMATION | `0x00001000` | Read identity, image path, and exit state |
| `"lifetime-owner"` | QUERY_LIMITED_INFORMATION, DUP_HANDLE, SYNCHRONIZE | `0x00101040` | `bindCurrentProcessLifetimeTo(owner)` |
| `"job-member"` | QUERY_LIMITED_INFORMATION, SET_QUOTA, TERMINATE | `0x00001101` | `job.assignProcess(target)` |

All modes support observation. A denied open throws `access-denied`; it does not retry with
different rights. Binding requires `"lifetime-owner"`, and assignment requires `"job-member"`.
Using either operation with a different mode throws `invalid-argument` before any side effect,
with `details: { reason: "insufficient-pin-access", required, actual }`. Pins never upgrade
rights or reopen the PID. For example:

```ts
using target = PinnedProcess.open(pid, {
  expect: { imagePath, startTimeMicros },
  access: "job-member",
});
if (target) job.assignProcess(target);
```

`create` defaults to `killOnJobClose: true`. A duplicate name throws without changing the
existing job. `open` returns null only for a proven missing name; denial throws. It owns a
new local handle: all owners must close before kill-on-close takes effect. Job enumeration
returns one complete observation, bounded to 4096 members, or throws `incomplete`; the list
is not authority to act on a PID. Accounting and enumeration do not wait for extinction.

`spawn` uses an explicit executable and raw Windows command line; quoting and shell choice
belong to the caller. It supplies atomic job admission and an inherited-handle allowlist.
The child receives NUL stdin and owned stdout/stderr pipes, starts in a new process group,
and has no console window. Omitted environment inherits; a supplied environment replaces
the block passed to Windows.
proc-safe passes exactly the caller's entries (an empty block for `{}`); Windows may add
loader/platform variables in the child, such as `PROCESSOR_ARCHITECTURE`. See Microsoft's
[architecture environment documentation](https://learn.microsoft.com/en-us/windows/win32/winprog64/wow64-implementation-details).
Environment names containing `=` or duplicate names ignoring case are rejected. NULs are
rejected in strings. `cwd` is optional. No shell fallback or post-launch admission is used.

Reads return available bytes up to the positive unsigned 32-bit `maxBytes`, an empty Buffer
when no data is currently available, or null at proven EOF. They never wait for data. Callers
own polling, byte decoding, fairness, and output budgets. EOF does not prove descendant
extinction; descendants can close output while continuing to run. `exitCode()` observes
the retained root process, including the valid exit code 259. `close()` releases child
handles and pipes; it does not itself terminate the job or certify extinction.

All resource objects are frozen and close/dispose idempotently. Other operations after
close or ownership consumption throw `invalid-argument`. Native finalization also closes
ordinary resources; deterministic close remains the caller's responsibility.

## Process lifetime ownership

`retainCurrentProcessJobUntilExit(job)` assigns the caller and consumes its local job owner.
The handle remains open until OS process exit, even if the originating Worker exits or JS
objects are collected. Dispose becomes a no-op. On failure the unconsumed job remains owned
by the caller. Using a kill-on-close job means process exit also terminates its descendants.

`bindCurrentProcessLifetimeTo(owner)` creates a fresh kill-on-close job, verifies that the
pinned owner is still live, duplicates a non-inheritable job handle into it, assigns the
current process, and closes the local job handle. The remote owner becomes the sole handle
owner; its exit kills this process and job descendants. No JavaScript job is returned.
The operation cleans the remote duplicate if admission fails. If the owner dies during the
handoff, the caller is either not admitted or is killed when the last local handle closes.
The owner must be a cooperating process: independently closing or duplicating handles in
its handle table can change lifetime semantics. This API adds no service/launcher policy.

## Real boundary proof

The Windows x64 and ARM64 native CI lanes run `scripts/windows-job-proof.mjs` under Node and
Bun. Each exercises main-thread and Worker owners, output drainage, retained exited identity,
exit code 259, named jobs, cancellation, detached descendants, output EOF before extinction,
nested jobs, Worker cleanup, process death, retained process lifetime, remote-handle rollback,
and owner death during handoff. An independent Rust fixture supplies descendants and owners.
Each thread also tests wrong-mode refusals and an observer of a process whose DACL denies
DUP_HANDLE. For the denial proof, the separate test addon impersonates the calling thread,
disables SeDebugPrivilege, invokes the same pinned-open path, and always reverts before
returning. The process token is unchanged. The test addon queries granted handle access using
ObjectBasicInformation and verifies all three exact masks on the main thread and a Worker.

The `fault-injection` Cargo feature is off by default. Windows CI builds its addon in a
separate target directory and tests post-duplication rollback on Node and Bun, both on the
main thread and in a Worker. The production build and package collector reject artifacts
containing the test-only fault export; platform packages never receive this addon.

## Explicit breakaway spawning

Jobs created with `{ allowBreakaway: true }`, including lifetime-bound Jobs,
retain kill-on-close and add `JOB_OBJECT_LIMIT_BREAKAWAY_OK`. They never enable
silent breakaway: ordinary children remain contained. The default is false.
Every containing Job must permit breakaway; permitting only an outer Job is
insufficient when the current process also belongs to a nested command Job.

`spawnWindowsProcess(command, args, options)` delegates to Node's `spawn` unchanged
unless `breakawayFromJob: true` is explicitly requested. The default route works
on all Node platforms and does not load a native binding. The opt-in route requires
Windows x64/ARM64 and an explicit executable path, and rejects shell execution.

The payload has a new process group and no console window. The opt-in route
launches the package's native `proc-safe-spawn.exe` with the caller-supplied stdio,
cwd and environment. The launcher passes those exact standard handles and Node's
inherited CRT descriptor table through an
explicit handle allowlist to `CreateProcessW(CREATE_BREAKAWAY_FROM_JOB)`. There is
no pipe proxy, environment file, or byte protocol. JSON IPC on an `ipc` descriptor
continues directly between the caller and payload; native handle transfer through
Node `sendHandle` is unsupported because Node records the launcher's PID.

The returned `ChildProcess` describes the native launcher: its PID, signal/abort
handling and `kill()` target the launcher, while the payload has a separate PID.
Callers needing independent lifetime must retain and settle their own payload
identity. The launcher forwards the payload's exit code while it remains alive.
A payload creation failure exits the launcher with code 1 and a stderr diagnostic;
it is not a Node spawn-error event. Once the payload starts it can outlive both the
containing Job and launcher, so stopping only the launcher does not stop it.

The Windows proof runs on the main thread and a Worker, with a lifetime-bound
outer Job and nested command Job. It checks quoted/empty/Unicode arguments,
argv0, synthetic environment, explicit-child survival, ordinary-child extinction,
and denied breakaway when the inner Job uses its default. It also verifies
inherited stdin/stdout traffic, an output receipt after owner death, and JSON IPC
before owner death. A payload that closes stdout and IPC while staying alive also
proves that EOF/disconnect reaches the caller before the launcher exits. The
ordinary Job/child tests remain unchanged.
