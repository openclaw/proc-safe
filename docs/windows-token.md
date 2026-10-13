# Windows process token

```ts
import { isSupported, readCurrentAppContainerSid } from "@openclaw/proc-safe/windows-token";

if (isSupported()) {
  const sid = readCurrentAppContainerSid();
  console.log(sid === null ? "Outside an AppContainer" : `AppContainer: ${sid}`);
}
```

```ts
function isSupported(): boolean;
function readCurrentAppContainerSid(): string | null;
```

`isSupported()` reports whether the platform is Windows and the native token
capability is available. It never throws. Importing the subpath does not load the
addon; calling `isSupported()` may attempt its lazy load.

`readCurrentAppContainerSid()` synchronously reads the current **process** token,
including when called from a real Worker or an impersonating thread. It returns
the AppContainer SID (such as `S-1-15-2-…`) when contained. `null` means a successful
token query proved the process is not in an AppContainer. Results are not cached.

Anything unknown throws `ProcSafeError`: `unsupported-platform` off Windows,
`helper-unavailable` if Windows native support is absent or disabled,
`access-denied` for denied token access, `layout-mismatch` for invalid token data,
and `operation-failed` for other native failures. A supported binding does not
promise that token access will succeed. No token failure is reported as `null`.

This is a fact API. Runtime-version checks, child-spawn admission, and user-facing
recovery policy belong to the caller. For example, an application can use the SID
to reject a piped child spawn when its runtime's libuv lacks AppContainer support.
The package does not start a child, change the token, or enforce that policy.

CI creates a disposable AppContainer profile and launches an isolated copy of
the runtime and capability import closure with `SECURITY_CAPABILITIES`. Main-thread and Worker queries
must equal the profile SID; outside queries must return `null`. A separate real
token-denial fixture verifies typed failures. Windows x64 and ARM64 run both Node
and Bun proofs. Test profiles and directories are removed afterward.
