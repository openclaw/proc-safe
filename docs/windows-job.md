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
  readonly stdin?: "null" | "pipe";
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
};
class WindowsJob implements Disposable {
  static create(options?: { name?: string; killOnJobClose?: boolean }): WindowsJob;
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
  writeStdin(bytes: Buffer): number | null;
  closeStdin(): void;
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
function bindCurrentProcessLifetimeTo(owner: PinnedProcess): void;
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
The child receives NUL stdin by default and owned stdout/stderr pipes, starts in a new process group,
and has no console window. Omitted environment inherits; a supplied environment replaces
the block passed to Windows.
proc-safe passes exactly the caller's entries (an empty block for `{}`); Windows may add
loader/platform variables in the child, such as `PROCESSOR_ARCHITECTURE`. See Microsoft's
[architecture environment documentation](https://learn.microsoft.com/en-us/windows/win32/winprog64/wow64-implementation-details).
Environment names containing `=` or duplicate names ignoring case are rejected. NULs are
rejected in strings. `cwd` is optional. No shell fallback or post-launch admission is used.

### Private input

Opt into `stdin: "pipe"` to give the child an owned private input stream. Omitted stdin or
`stdin: "null"` retains NUL behavior. Spawn never queues or sends input: callers can verify
and bind the child's PID/birth identity before explicitly releasing any bytes.

```ts
using child = job.spawn({ executable, commandLine, stdin: "pipe" });
// Verify/bind identity here according to your application's policy, before writing.
// In your scheduling loop, drain output and attempt the remaining input prefix:
const accepted = child.writeStdin(remaining);
if (accepted === null) {
  // The reader has disconnected; input was not fully delivered.
} else {
  remaining = remaining.subarray(accepted); // zero means no bytes accepted; yield before trying again
  if (remaining.length === 0) child.closeStdin();
}
```

`writeStdin` requires a nonempty `Buffer` of at most 2^32−1 bytes. It returns the number of
prefix bytes accepted immediately, including a partial prefix or zero when no bytes are accepted.
Zero does not prove that the pipe is full. Each call makes one kernel write attempt of at most
64 KiB; larger buffers can produce a positive partial result even when the pipe has capacity.
It never waits for the child to read. It retains no buffer, queues no suffix, and performs no retry.
Accepted bytes are copied into the kernel stream; this is not proof of child consumption.
Any positive result has **already released that prefix**, even if a later write returns
zero, disconnects, or throws. An incomplete grant must not be described as withheld:
track release from the first positive acceptance, independently of complete delivery.
Even complete kernel acceptance does not prove that the child consumed the grant.
Callers own scheduling, concurrent output drainage, byte/elapsed-time budgets, and deciding
whether to send more. Do not call it with an empty remainder.

A proven broken/disconnected read endpoint returns `null`, including repeated attempts until
explicit input close. Other native failures throw typed errors, without input bytes or the
internal pipe name. Root exit alone does not close input: a descendant may inherit the read
endpoint and continue consuming. Successful writes do not prove the root is alive or that
all descendants have exited.

`closeStdin()` idempotently closes the native-owned writer, allowing the reader to observe
EOF after accepted bytes drain. It also safely does nothing for default NUL input. Writes
without pipe input or after `closeStdin()` throw `invalid-argument`. `child.close()`, native
finalization/Worker teardown, and owner-process exit close the writer too; closing the child
does not terminate its job. After child close, `closeStdin()` and writes throw
`invalid-argument`, like other child operations.

The implementation uses a local byte-mode named pipe with a non-inheritable parent writer
in `PIPE_NOWAIT` mode and a blocking child reader. This is an immediate polling write API,
not overlapped/background I/O. It does not assume that anonymous `CreatePipe` handles
support nonblocking writes. Microsoft documents the accepted-prefix semantics in
[named pipe wait modes](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-type-read-and-wait-modes).
The name uses 128 bits from the Windows system cryptographic RNG. Creation rejects a
pre-existing first instance and remote clients, and verifies the connected local client
PID before exposing the writer or launching the child. An intercepted connection fails
closed before any input write. Only the reader joins the existing child handle allowlist;
no writer handle, pipe name, or raw handle is exposed to JavaScript or passed in argv/env.

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
nested jobs, private-input gating/backpressure/EOF, root exit with an inherited input reader,
input-owner closure and death, Worker cleanup, process death, retained process lifetime, remote-handle rollback,
and owner death during handoff. An independent Rust fixture supplies descendants and owners.
The private-input proof also tests the Doctor nesting order: a parent retains an outer
kill-on-close Job and atomically admits a child before that child creates and retains a
distinct inner kill-on-close Job, on main and in a real Worker, before reading input.
It observes live outer descendant accounting before zero, both when inner kill-on-close
terminates descendants at child exit and when the parent terminates the outer Job.
Closing the parent writer while the child is still alive must let that child observe EOF;
an inherited writer would keep the pipe open and prevent this observation.
Each thread also tests wrong-mode refusals and an observer of a process whose DACL denies
DUP_HANDLE. For the denial proof, the separate test addon impersonates the calling thread,
disables SeDebugPrivilege, invokes the same pinned-open path, and always reverts before
returning. The process token is unchanged. The test addon queries granted handle access using
ObjectBasicInformation and verifies all three exact masks on the main thread and a Worker.

The `fault-injection` Cargo feature is off by default. Windows CI builds its addon in a
separate target directory and tests post-duplication rollback on Node and Bun, both on the
main thread and in a Worker. A test-only synchronization hook also lets an independent
local client connect before the owner's own open. The test checks that the owner fails,
the intended child is not launched, and the competitor receives no bytes. This exercises
the busy-pipe failure path using the separate test addon; it does not force the distinct
client-PID-mismatch branch. The production build and package collector reject artifacts
containing test-only exports; platform packages never receive this addon.
