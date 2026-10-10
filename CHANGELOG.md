# Changelog

## Unreleased

- Reap children killed by Linux real-time signals instead of leaving zombies, and expose `ChildExit.signalNumber` for all signal exits.

- Add Linux subreaper admission, non-consuming child wait observations, and PID-specific reaping, plus bounded page-cache residency diagnostics and test-only Linux group-kill denial and Windows raw-spawn/console fixtures.
- Add lazy Linux systemd connections with authenticated direct peers, ordered asynchronous calls, native timeouts, bounded typed replies, and exact bigint counters.
- Add Darwin and Windows command inspection with exact argument boundaries, Windows cwd and raw command line, and explicitly selected environment keys; refuse inspection under Rosetta.

- Add lazy native process identity and ancestry observations for Darwin, Linux, Windows, and FreeBSD, plus Darwin resource-coalition IDs and optional names.
- Report retained exited process objects and boot-relative birth times on Linux/FreeBSD for clock-change-safe identity comparisons.
- Define ten platform packages with native runtime and isolated consumer-install checks.
- Require the exact protected-tag certificate identity when verifying release provenance.
