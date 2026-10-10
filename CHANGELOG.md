# Changelog

## Unreleased

- Add Linux subreaper admission, non-consuming child wait observations, and PID-specific reaping, plus bounded page-cache residency diagnostics and test-only Linux group-kill denial and Windows raw-spawn/console fixtures.

- Add lazy native process identity and ancestry observations for Darwin, Linux, Windows, and FreeBSD, plus Darwin resource-coalition IDs and optional names.
- Report retained exited process objects and boot-relative birth times on Linux/FreeBSD for clock-change-safe identity comparisons.
- Define ten platform packages with native runtime and isolated consumer-install checks.
- Require the exact protected-tag certificate identity when verifying release provenance.
