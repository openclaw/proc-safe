# Identity and visibility

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
