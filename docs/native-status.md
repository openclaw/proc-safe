# Native runtime status

```ts
import {
  getProcSafeNativeStatus,
  type ProcSafeNativeMode,
  type ProcSafeNativeStatus,
  type ProcSafeNativeStatusReason,
} from "@openclaw/proc-safe";

const native = await getProcSafeNativeStatus({ probe: true });
console.log(native.loaded ? "Native helper active" : `Native helper: ${native.reason}`);
if (native.guidance) console.log(native.guidance);
```

```ts
function getProcSafeNativeStatus(options?: { probe?: boolean }): Promise<ProcSafeNativeStatus>;

type ProcSafeNativeMode = "auto" | "off" | "require";
type ProcSafeNativeStatusReason =
  | "not-probed" | "loaded" | "disabled" | "unsupported-target"
  | "package-missing" | "load-failed" | "capability-missing";
type ProcSafeNativeStatus = {
  mode: ProcSafeNativeMode;
  modeSource: "PROC_SAFE_NATIVE" | "default";
  reason: ProcSafeNativeStatusReason;
  loaded: boolean;
  target: string;
  packageName?: string;
  packageVersion?: string;
  loadErrorCode?: string;
  guidance?: string;
};
```

The root import stays lightweight; the first call loads the status module. The default,
`{ probe: false }`, reads the cached outcome without loading the addon. `{ probe: true }`
attempts the same lazy load as a native operation unless `PROC_SAFE_NATIVE=off`. It never
changes the configured mode or performs process mutations. Failed loads are reported even
in `require` mode, without throwing. An invalid `PROC_SAFE_NATIVE` setting still throws
`ProcSafeError` with code `invalid-argument`.

| Field | Meaning |
|---|---|
| `mode`, `modeSource` | Effective policy and its source; only the environment variable name is exposed. |
| `reason` | Cached outcome; `not-probed` until a load is attempted, unless mode is `off` (`disabled`). |
| `loaded` | True exactly for `loaded`: the core identity capability is present, not a promise that every operation is available. |
| `target` | Runtime platform/architecture/libc, including unsupported targets. |
| `packageName`, `packageVersion` | Expected platform package and its exact pinned manifest version; absent for unsupported targets. |
| `loadErrorCode` | Allowlisted loader code, or `UNKNOWN`, only for `load-failed`. |
| `guidance` | Cause-specific next steps; absent for `not-probed` and `loaded`. |

`package-missing` identifies an unresolved platform package. A missing dependency inside
an installed package is `load-failed`. `capability-missing` means the core identity function
is absent; individual operations can still lack capabilities when status reports `loaded`.
No field contains filesystem paths, raw loader errors, or environment variable values.

For `disabled`, keep intentional off settings or set `PROC_SAFE_NATIVE=auto` or `require`.
For `package-missing`, reinstall with optional dependencies included and check the lockfile
and registry mirror. For `load-failed`, check Node architecture, Linux libc compatibility,
package dependencies, and OS code-integrity policy; reinstalling identical bytes may not help.
For `capability-missing`, use matching proc-safe and platform-package versions. Native process
capabilities are unavailable on unsupported targets.

Status is per module instance. A real Worker has its own loader cache and status; checking
the main thread does not probe its Workers. Restart the process or Worker after repairing
an installation: successes and failures are cached, and neither repeated probes nor mode
changes retry a failed load.
