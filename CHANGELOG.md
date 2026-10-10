# Changelog

## Unreleased

- Clarify systemd declarations with `target` and `options` parameter names and timeout-only `SystemdConnectOptions` for connection factories; reply budgets remain in `SystemdCallOptions` for property reads and method calls.

- Stabilize Linux epoch birth estimates with realtime/boottime samples, removing the extra second of `btime` truncation while preserving exact tick-quantized process identity.

- Infer systemd property value types from their signatures, and distinguish user-manager ownership refusals with `peer-uid-mismatch` details containing the expected and actual effective UIDs.

- Reap children killed by Linux real-time signals instead of leaving zombies, and expose `ChildExit.signalNumber` for all signal exits.

- Add Linux subreaper admission, non-consuming child wait observations, and PID-specific reaping, plus bounded page-cache residency diagnostics and test-only Linux group-kill denial and Windows raw-spawn/console fixtures.
- Add lazy Linux systemd connections with authenticated direct peers, ordered asynchronous calls, native timeouts, bounded typed replies, and exact bigint counters.
- Add Darwin and Windows command inspection with selected environment keys, plus complete Windows process censuses with explicit unknown facts and timeout enforcement; refuse command inspection under Rosetta.

- Add lazy native process identity and ancestry observations for Darwin, Linux, Windows, and FreeBSD, plus Darwin resource-coalition IDs and optional names.
- Report retained exited process objects and boot-relative birth times on Linux/FreeBSD for clock-change-safe identity comparisons.
- Define ten platform packages with native runtime and isolated consumer-install checks.
- Require the exact protected-tag certificate identity when verifying release provenance.
