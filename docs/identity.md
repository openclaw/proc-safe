# Identity and visibility

## Ancestry

`readProcessAncestry(pid, { maxDepth?, throughPid? })` returns a frozen
`{ chain, complete, stoppedBy }` snapshot, or `null` if the starting process is
provably gone. `chain` contains the starting identity first. `maxDepth` defaults
to 32. `maxDepth` counts the starting process. `throughPid` stops after including
that PID, including when
it is the starting PID. The stop at `throughPid` takes precedence over the depth
limit. A parent born after its child is excluded using boot-relative births where
available, otherwise epoch births.

| `stoppedBy` | `complete` | Meaning |
|---|---|---|
| `root` | `true` | The last observed process has parent PID 0 or 1; neither parent is read. |
| `missing-parent` | `true` | The parent is provably gone. |
| `recycled-parent` | `true` | The recorded parent PID now identifies a process born after its child. |
| `through-pid` | `true` | The requested PID was included. |
| `cycle` | `false` | Following the parent would revisit an observed PID. |
| `max-depth` | `false` | The depth limit prevents another observation. |
| `unreadable-parent` | `false` | The parent identity is unknown, including denied access or visibility policy. |

Invalid arguments and failure to identify the starting PID throw `ProcSafeError`.
Starting with `pid <= 1` throws `invalid-argument` with
`details: { reason: "init-process" }` before any native read; `readProcessIdentity(1)`
is unchanged. Ancestry never reads PID 0 or 1.
Once the starting identity is known, parent observation failures never throw:
the partial chain remains useful for callers protecting observed ancestors.
`complete` describes why this walk ended, not an atomic census or a claim that
every ancestor is still alive. Applications decide whether partial observations
are sufficient for their operation.

This is a breaking change from 0.1: use `result?.chain` instead of the former
array return, handle `null` for a gone start, and check `complete`/`stoppedBy`
instead of assuming an array reached the root or catching parent read errors.

## Visibility and identity

`null` proves absence only in a permissive process view. FreeBSD caches the three
`security.bsd.see_*` settings and `security.jail.jailed` at first use; Linux caches
the `hidepid` options of the `/proc` mount actually used. If that view can hide a
process, a missing-record result throws `ProcSafeError` with `code: "access-denied"`
and `details: { reason: "visibility-policy" }`. Failure to read the policy is
restricted too. Restart the process after changing its visibility policy or procfs
mount. A successful observation can still describe an exited kernel object;
compare `startTimeSinceBootMicros` when present, otherwise `startTimeMicros`.

On Linux, `startTimeMicros` is an estimate in the **current** wall-clock frame,
computed from the process's boot-relative birth and bracketed realtime/boottime
samples at each read. Its uncertainty relative to that frame is less than
`2 * startTimeResolutionMicros + 1` microseconds: less than one tick lost when
procfs records birth, at most one tick for clock sampling, and less than one
microsecond lost in conversion. Unacceptably wide samples or observed clock
discontinuities throw `incomplete`. This bound does not limit wall-clock
corrections since the process was born: historical epoch time cannot be recovered
after those corrections. The estimate can change between reads, while
`startTimeSinceBootMicros` remains stable and tick-quantized. Use the latter for
identity and parentage comparisons. Neither value is cached.
