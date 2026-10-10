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
  static create(options?: { name?: string; killOnJobClose?: boolean }): WindowsJob;
  static open(name: string): WindowsJob | null;
  assignCurrentProcess(): void;
  assignProcess(process: PinnedProcess): void;
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
  static open(pid: number, expect?: { imagePath?: string; startTimeMicros?: number }): PinnedProcess | null;
  readonly identity: ProcessIdentity;
  readonly imagePath: string;
  close(): void;
  [Symbol.dispose](): void;
}
function isCurrentProcessInJob(): boolean;
function retainCurrentProcessJobUntilExit(job: WindowsJob): void;
function bindCurrentProcessLifetimeTo(owner: PinnedProcess): void;
function isSupported(): boolean;
```

`ProcessIdentity` is the existing [identity type](identity.md). The pinned getter reads the
retained kernel handle afresh, including `exited`; it never reopens a PID. Image and birth
expectations must match exactly or throw `operation-failed`. Only a proven missing process
returns null. Opening a pin acquires query, synchronization, duplicate, and job-assignment
rights; denial throws even if a weaker observation might have succeeded. Image/ancestry
selection and authorization policy remain in the caller.

`create` defaults to `killOnJobClose: true`. A duplicate name throws without changing the
existing job. `open` returns null only for a proven missing name; denial throws. It owns a
new local handle: all owners must close before kill-on-close takes effect. Job enumeration
returns one complete observation, bounded to 4096 members, or throws `incomplete`; the list
is not authority to act on a PID. Accounting and enumeration do not wait for extinction.

`spawn` uses an explicit executable and raw Windows command line; quoting and shell choice
belong to the caller. It supplies atomic job admission and an inherited-handle allowlist.
The child receives NUL stdin and owned stdout/stderr pipes, starts in a new process group,
and has no console window. Omitted environment inherits; `{}` is an empty environment.
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
