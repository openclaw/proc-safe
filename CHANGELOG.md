# Changelog

## Unreleased

## 0.1.0 - 2026-10-10

First release.

- `@openclaw/proc-safe/identity`: process identity and ancestry for Darwin, Linux, Windows, and FreeBSD — parent PID, exact birth time, clock-change-safe boot-relative birth on Linux/FreeBSD, and exited-but-retained state. Proven absence returns `null`; anything uncertain, including processes hidden by FreeBSD visibility sysctls or Linux `hidepid`, throws `ProcSafeError`.
- `@openclaw/proc-safe/inspect`: Darwin and Windows command inspection (executable, argv, Windows cwd and raw command line) that only returns the environment keys you name, plus complete Windows process censuses with explicit unknown facts and enforced timeouts. Command inspection refuses to guess under Rosetta.
- `@openclaw/proc-safe/windows-job`: Windows Job Objects on x64 and ARM64 — atomic child admission with handle allowlists, nonblocking owned output, least-privilege pinned processes, process-lifetime retention, and lifetime transfer to a verified owner with rollback.
- `@openclaw/proc-safe/reaper`: Linux subreaper admission, non-consuming child wait observations, and PID-specific reaping that reports `signalNumber` for every signal exit, real-time signals included.
- `@openclaw/proc-safe/systemd`: lazy sd-bus connections with authenticated direct peers, ordered asynchronous calls, native timeouts that include queue time, bounded replies, signature-typed property values, and stable `peer-uid-mismatch` refusals.
- `@openclaw/proc-safe/darwin`: resource-coalition IDs with optional names.
- `@openclaw/proc-safe/diagnostics`: page-cache residency sampling that never faults file data in.
- `@openclaw/proc-safe/test-support`: fixtures for testing supervisors (Linux group-kill seccomp denial, Windows console-free raw spawns).
- Prebuilt N-API bindings for ten targets — macOS arm64/x64, Linux glibc/musl x64/arm64, Windows x64/arm64, FreeBSD 14.4+ x64/arm64 — loaded on first use, never at import time, with `PROC_SAFE_NATIVE=auto|off|require`.
- Releases publish with npm provenance; verification requires the exact protected-tag certificate identity.
