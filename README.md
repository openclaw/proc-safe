# 🧬 @openclaw/proc-safe

![proc-safe banner](docs/assets/readme-banner.jpg)

[![npm](https://img.shields.io/npm/v/@openclaw/proc-safe.svg?color=2dd4bf&label=npm)](https://www.npmjs.com/package/@openclaw/proc-safe)
[![ci](https://github.com/openclaw/proc-safe/actions/workflows/ci.yml/badge.svg)](https://github.com/openclaw/proc-safe/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@openclaw/proc-safe.svg?color=2dd4bf)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-2dd4bf.svg)](LICENSE)

Race-resistant process primitives for Node.js: who is this PID really, what is it running,
which children are mine, and how do I make sure they die with me.

Node gives you `process.kill(pid, 0)` and `child_process`. That answers "does *a* process with
this number exist right now", which is the wrong question for lock files, supervisors, and
cleanup code. PIDs get reused. Children get adopted. Windows has no process groups. Exit codes
lie when a job is terminated. proc-safe answers the right questions with small, typed,
native-backed capabilities — the process sibling of
[`@openclaw/fs-safe`](https://github.com/openclaw/fs-safe).

```ts
import { readProcessIdentity } from "@openclaw/proc-safe/identity";

// Record who owns a lock: pid + birth time, not just a pid.
const owner = readProcessIdentity(process.pid)!;

// Later, possibly in another process:
const current = readProcessIdentity(owner.pid);
const sameProcess =
  current !== null &&
  !current.exited &&
  (current.startTimeSinceBootMicros ?? current.startTimeMicros) ===
    (owner.startTimeSinceBootMicros ?? owner.startTimeMicros);
```

No runtime downloads, postinstall scripts, shell fallbacks, or FFI engine. Each capability is a
Rust N-API function behind a narrow TypeScript API, and the native addon loads on first use —
never at import time.

## Contents

[Install](#install) · [Capabilities](#capabilities) · [Three outcomes](#three-outcomes-never-guess) ·
[Process identity](#process-identity) · [Command inspection](#command-inspection-and-process-census) ·
[Windows jobs](#windows-jobs) · [Linux reaping](#linux-child-reaping) · [systemd](#systemd) ·
[Diagnostics](#diagnostics-and-test-fixtures) · [Native loading](#native-loading) ·
[Platforms](#platforms) · [Safety model](#safety-model) · [License](#license)

## Install

```sh
npm install @openclaw/proc-safe
# or
pnpm add @openclaw/proc-safe
```

Node.js 22 or newer. The matching prebuilt binary arrives as an optional platform package; there
is nothing to compile. Bun is supported on every platform it ships for.

## Capabilities

Every capability is its own subpath, so you only load what you use.

| Subpath | What it answers | Platforms |
|---|---|---|
| [`/identity`](docs/identity.md) | Who is this PID: parent, exact birth time, exited-but-retained state, ancestry | Darwin, Linux, Windows, FreeBSD |
| [`/inspect`](docs/inspect.md) | Executable, argv, selected env keys; complete process census with parentage and ownership; Darwin groups and state | Darwin, Windows |
| [`/windows-token`](docs/windows-token.md) | Is this process in an AppContainer, and which SID identifies it | Windows |
| [`/windows-job`](docs/windows-job.md) | Spawn into a Job atomically, own its output, tie your lifetime to another process | Windows |
| [`/reaper`](docs/reaper.md) | Become a subreaper, observe child wait state without consuming it, reap one specific child | Linux |
| [`/systemd`](docs/systemd.md) | Talk to systemd over sd-bus with authenticated peers and real deadlines | Linux |
| [`/darwin`](docs/api.md) | Which resource coalition does this process belong to | Darwin |
| [`/diagnostics`](docs/diagnostics.md) | How much of this file is in the page cache, without faulting it in | Linux |
| [`/test-support`](docs/test-support.md) | Test fixtures: seccomp group-kill denial, raw console-free spawns | Linux, Windows |
| `/errors` | `ProcSafeError` and its codes | everywhere |

Every capability subpath imports on every platform and exports `isSupported()`, which never throws.
Calling a capability where it doesn't exist throws `unsupported-platform` — no silent no-ops.

## Three outcomes, never guess

Process questions have a third answer that most APIs hide: *I couldn't tell*. proc-safe keeps it:

- **A value** — the observation succeeded.
- **`null`** — the process *provably* does not exist.
- **`ProcSafeError`** — anything not proven: access denied, timeouts, incomplete enumerations,
  unexpected kernel layouts, a missing native binding.

Unknown is never reported as absent. That matters on systems that hide processes: when FreeBSD's
`security.bsd.see_other_uids` or Linux's `hidepid` can hide a PID, "not found" is ambiguous and
throws `access-denied` with `details.reason === "visibility-policy"` instead of returning `null`.

```ts
import { ProcSafeError } from "@openclaw/proc-safe/errors";

try {
  const identity = readProcessIdentity(pid);
  if (identity === null) releaseStaleLock();         // proven gone
} catch (error) {
  if (error instanceof ProcSafeError) keepLock();    // unknown: never treat as dead
  else throw error;
}
```

Codes: `unsupported-platform`, `helper-unavailable`, `access-denied`, `layout-mismatch`,
`timeout`, `incomplete`, `invalid-argument`, `operation-failed`. Stable `details.reason` values
are documented per subpath.

## Process identity

```ts
type ProcessIdentity = {
  pid: number;
  parentPid: number;
  startTimeMicros: number;            // µs since the Unix epoch
  startTimeResolutionMicros: number;  // 1 on Darwin/FreeBSD/Windows, one clock tick on Linux
  startTimeSinceBootMicros?: number;  // Linux, FreeBSD: immune to wall-clock changes
  exited: boolean;                    // zombie, or a Windows object kept alive by handles
};
```

Compare `startTimeSinceBootMicros` when both sides have it; it can't move when someone sets the
clock. Ancestry returns a self-first chain with explicit completeness:

```ts
import { readProcessAncestry } from "@openclaw/proc-safe/identity";

const ancestry = readProcessAncestry(process.pid, { maxDepth: 32 });
if (ancestry) {
  const observedPids = ancestry.chain.map(identity => identity.pid);
  console.log(observedPids, ancestry.complete, ancestry.stoppedBy);
}
```

`null` means the starting process is provably gone; an unknown starting identity throws.
An unreadable parent preserves the partial chain with `complete: false` and
`stoppedBy: "unreadable-parent"`. A root, missing or recycled parent ends a complete
walk; a cycle or depth limit is incomplete. `throughPid` stops after including the
requested ancestor and is complete. Starting with PID ≤1 throws `invalid-argument`
with `details.reason === "init-process"` before any native read; PID 0 and 1 are never read.
Details and migration from the former array return: [identity and visibility](docs/identity.md).

## Command inspection and process census

```ts
import { readProcessCommand, listProcesses } from "@openclaw/proc-safe/inspect";

const command = readProcessCommand(pid, { environmentKeys: ["MY_SERVICE_ID"] });
// { executable, argv, cwd?, commandLine?, environment: { MY_SERVICE_ID?: string } }
```

Only the environment keys you name ever leave native code. On Darwin and Windows,
`listProcesses({ timeoutMs })` returns a complete census or throws — never a silently partial
list — and accepts `pids` to inspect only selected processes. Rows keep unknown facts explicit (`owner: "unknown"`, no `identity`) instead of
dropping protected processes. Darwin reports parent PID, process group, and kernel state
independently of restricted birth identity, including foreign-owner topology, zombies, and processes already exiting.
Linux and FreeBSD census remains unsupported. [Command inspection and census](docs/inspect.md).

## Windows jobs

```ts
import { WindowsJob, PinnedProcess, bindCurrentProcessLifetimeTo } from "@openclaw/proc-safe/windows-job";

using job = WindowsJob.create();                       // kill-on-close by default
const child = job.spawn({ executable: "C:\\Windows\\System32\\cmd.exe", commandLine: "cmd /c build.cmd" });

// Die together with the process that launched us, without ever touching a HANDLE.
const owner = PinnedProcess.open(launcherPid, { access: "lifetime-owner", expect: { startTimeMicros } });
if (owner) bindCurrentProcessLifetimeTo(owner);
```

Children join the Job atomically at creation, inherit only the handles you allow, and stream
output without blocking. Pins request least-privilege access by intended use. Lifetime transfer
rolls back cleanly if anything fails halfway. [Windows jobs](docs/windows-job.md).

## Linux child reaping

```ts
import { becomeChildSubreaper, inspectChildWaitState, reapChild } from "@openclaw/proc-safe/reaper";

becomeChildSubreaper();
const state = inspectChildWaitState(adoptedPid);   // never reaps
if (state.kind === "exited") reapChild(adoptedPid);
```

There is deliberately no "reap any child": libuv owns the exit status of the children Node spawned.
Real-time signal exits report `signalNumber` even when Node has no name for the signal.
[Child reaping](docs/reaper.md).

## systemd

```ts
import { SystemdBus } from "@openclaw/proc-safe/systemd";

await using bus = await SystemdBus.connectUserManager(address, { timeoutMs: 5_000 });
console.log(bus.peer);   // authenticated { pid, uid } of the manager
const tasks = await bus.getProperty(target, "t", { timeoutMs: 2_000 });   // bigint
```

`libsystemd.so.0` loads lazily; importing on Alpine or anywhere without it is fine. Calls are
ordered per connection, timeouts include queue time, auto-start is off, and replies are size-bounded.
Only connections whose peer can actually be authenticated expose `peer`. [systemd](docs/systemd.md).

## Diagnostics and test fixtures

`samplePageCacheResidency(fd, { maxPages })` samples page-cache residency over a `PROT_NONE`
mapping, so it never faults file data in. `/test-support` contains fixtures for testing
supervisors — not for production code. [Diagnostics](docs/diagnostics.md) ·
[test support](docs/test-support.md).

## Native loading

`PROC_SAFE_NATIVE=auto` (default) loads the native binding on first use. `off` never loads it —
native-only operations then throw `helper-unavailable`. `require` makes a missing binding an
immediate error. Imports never load native code in any mode. [Native architecture](docs/native.md).

```ts
import { getProcSafeNativeStatus } from "@openclaw/proc-safe";

const native = await getProcSafeNativeStatus({ probe: true });
console.log(native.loaded ? "Native helper active" : `Native helper: ${native.reason}`);
if (native.guidance) console.log(native.guidance);
```

Without `probe: true`, this reads the cached state without loading the addon. Results omit
paths and raw loader errors. See [native status](docs/native-status.md) for fields and recovery guidance.

## Platforms

Prebuilt for ten targets, each tested on real hardware or a real kernel in CI, on the main thread
and in Workers, under Node 22 and 24 (and Bun where available):

| OS | Architectures |
|---|---|
| macOS | arm64, x64 |
| Linux (glibc and musl) | x64, arm64 |
| Windows | x64, arm64 |
| FreeBSD 14.4+ | x64, arm64 |

## Safety model

- **Name the capability, not the syscall.** No raw handles, pointers, or generic `call(symbol)` escape hatch.
- **Fail closed.** Ambiguity throws; nothing guesses on your behalf.
- **Own what you open.** Every native resource is an object with an idempotent `close()` and `Symbol.dispose` (`Symbol.asyncDispose` and an async `close()` for systemd connections).
- **No policy.** Budgets, retries, and fallbacks stay in your code; proc-safe reports facts and owns lifetimes.

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Releases are tag-driven with npm provenance; see
[RELEASE-PREREQS.md](RELEASE-PREREQS.md).

## License

[MIT](LICENSE) © 2026 OpenClaw Foundation.
