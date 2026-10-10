# Identity and visibility

`null` proves absence only in a permissive process view. FreeBSD caches the three
`security.bsd.see_*` settings and `security.jail.jailed` at first use; Linux caches
the `hidepid` options of the `/proc` mount actually used. If that view can hide a
process, a missing-record result throws `ProcSafeError` with `code: "access-denied"`
and `details: { reason: "visibility-policy" }`. Failure to read the policy is
restricted too. Restart the process after changing its visibility policy or procfs
mount. A successful observation can still describe an exited kernel object;
compare `startTimeSinceBootMicros` when present, otherwise `startTimeMicros`.
