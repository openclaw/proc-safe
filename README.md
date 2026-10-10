# @openclaw/proc-safe

Typed process identity, Darwin resource-coalition observations, Linux child reaping,
and page-cache diagnostics for Node.js 22+.
Native bindings load on the first operation, never at import time. No runtime downloads,
postinstall builds, shell fallback, or compression dependencies.

```ts
import { readProcessIdentity, readProcessAncestry } from '@openclaw/proc-safe/identity';
import { readProcessCoalition } from '@openclaw/proc-safe/darwin';

const identity = readProcessIdentity(process.pid);
const ancestors = readProcessAncestry(process.pid, { maxDepth: 32 });
if (process.platform === 'darwin') {
  const coalition = readProcessCoalition(process.pid);
}
```

Identity includes PID, parent PID, Unix-epoch `startTimeMicros`,
`startTimeResolutionMicros`, and `exited`. Linux and FreeBSD also provide
`startTimeSinceBootMicros`; prefer it for PID-reuse comparisons because wall-clock
changes cannot alter it. Darwin and Windows omit that field. An exited process whose
kernel object remains still has an identity with `exited: true`. Only a missing kernel
object returns `null`; uncertain observations throw
`ProcSafeError`. Coalitions carry a bigint ID and an optional name from private libxpc symbols.
Every subpath exports `isSupported()`, which never throws.

Set `PROC_SAFE_NATIVE=auto` (default), `off`, or `require`. These native-only APIs throw
`helper-unavailable` if their binding is absent or disabled. Unsupported platforms throw
`unsupported-platform`. `off` never attempts native loading.

Ten platform packages are defined for Darwin arm64/x64, Linux GNU/musl arm64/x64,
Windows arm64/x64, and FreeBSD arm64/x64 (14.4 or newer).

Read the [API](docs/api.md), [native architecture](docs/native.md),
[child reaping](docs/reaper.md), [page-cache diagnostics](docs/diagnostics.md),
[test fixtures](docs/test-support.md),
[contribution guide](CONTRIBUTING.md), and [security policy](SECURITY.md). MIT licensed.
