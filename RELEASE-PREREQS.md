# Release prerequisites

Publishing is protected-tag-driven through `.github/workflows/release.yml` using npm trusted
publishing. No local publication, token fallback, or npm settings change is part of development.

Eleven packages must exist in npm with GitHub Actions trusted publishers: `@openclaw/proc-safe`
and each of the ten names in `scripts/native-targets.mjs`. Configure organization `openclaw`,
repository `proc-safe`, workflow `release.yml`, and no environment. Maintainers require 2FA.
Initial package creation and publisher setup need a separate explicit authorization.

Before release, pass every native runtime gate, including FreeBSD 14.4 on x64 and ARM64.
Update the root, private native workspace, crate, ten platform versions, and ten exact optional
pins together. Regenerate lockfiles with `pnpm install` and `cargo update --workspace --offline`.
Finalize a dated, nonempty changelog section and verify `pnpm release:notes X.Y.Z`.

Run `pnpm check`, `cargo test --workspace --locked`, `cargo clippy --workspace --locked -- -D warnings`,
`pnpm native:build`, `pnpm package:smoke`, and `git diff --check`. All ten native bindings must
pass main-thread and Worker runtime checks. Host-only smoke is not foreign-platform proof.
Windows staging and package collection also verify x64/ARM64 PE dependencies: OS UCRT
must remain dynamic, with no external VC redistributable dependency. Tool-equipped
Windows CI runners can mask missing runtime prerequisites. Keep clean-Windows proof
separate: run the exact packed root/platform tarballs without a VC redistributable
on Node 22 and 24, on main and Worker threads, and record architecture-specific gaps.

Apply the coordinator-approved branch/tag rulesets first. The annotated protected `vX.Y.Z`
tag must point to reviewed, green, latest main. Never move a release tag. The workflow validates
this identity, builds and tests all targets, collects exact tarballs, tests root-only npm/pnpm
installs, then creates a draft GitHub Release. All platform packages publish and verify before
the root. Published versions are verified instead of republished on retry. Preserve the collected
tarballs; never rebuild them to bypass byte, signature, or provenance mismatches.

Registry operations run in pairs, with the root after all platform publications. Eleven-package
verification needs six rounds: at 530 seconds of retry sleeps per round, at most 53 minutes of
nominal sleeps fit inside the unchanged 90-minute job ceiling. Network and signature work also
consume that ceiling. Failure remains terminal; no timeout increase or weakened check is implied.

Registry verification pins canonical tarball URLs and checks exact SHA-512 bytes, npm registry
signatures, and Sigstore provenance bound to this repository, workflow, and version tag. Release
proof includes npm version pages, tarballs, integrity, attestations, and the Actions run. Only
successful verification and installed-package smoke promote the draft. Confirm finalized changelog/release-body agreement,
public release and annotated tag, dist-tags, publication times, and all eleven package records.
Leave clean synchronized main and follow the repository's Unreleased convention.

## Installed-package promotion gate

After all eleven public packages are published and cryptographically verified, fresh consumer
directories install the exact root version from `https://registry.npmjs.org`. This gate runs on
xcode-27 (ARM64 and x64 via Rosetta), ubuntu-latest, ubuntu-24.04-arm, windows-latest, and
windows-11-arm. Each runner checks its architecture and the exact matching native package,
imports every exported subpath, and runs supported read-only calls with default optional
settings on Node 24 and Bun, both on the main thread and in a Worker. It includes a full default
ancestry walk, self command inspection, Darwin coalition, Windows census and process pin,
Linux wait-state and temporary-file residency, plus every capability's `isSupported()`.
Systemd is probed only with `isSupported()`; no service connection or process mutation is made.

The macOS x64 consumer uses the pinned Bun setup action with an explicit x64 archive
and cache disabled. The action verifies the runtime before the package probe; setup
has a separate two-minute ceiling. The package probe retains its 30-second behavioral
limit. Cold runtime startup remains a separate diagnostic below, not a package gate.

Run the same public-registry smoke locally with `node scripts/installed-smoke.mjs X.Y.Z --bun`
(omit `--bun` for Node only). Installation uses an isolated cache and empty npm configuration.
Only installation retries: five attempts, with 5/10/20/40-second backoff, a 30-second fetch
timeout and a 120-second ceiling per attempt. A successful install's behavioral failure is
terminal. Failure leaves the GitHub Release draft intact and never deletes or republishes a
package. Re-run the failed gate after investigation; publication retries still verify existing
versions rather than republish them.

For a cold macOS x64 Bun failure, manually run `ci.yml` with `consumer_diagnostic=true`
and `consumer_version` set to the exact published version. This read-only consumer job
skips builds and ordinary CI jobs, keeps the release runtime versions and 30-second
behavioral limit, and by default never executes Bun before the probe. It records the resolved
Bun executable's hash and enables synchronous phase markers with
`PROC_SAFE_SMOKE_TRACE=1`. Markers contain phase, runtime, architecture, thread and
elapsed time; the first marker follows static module initialization. Select `startup_launch=arch` only for a separate comparison of
an explicit `/usr/bin/arch -x86_64` launcher; the default remains a direct Bun launch.
Neither startup variant replaces a package smoke check.
If both launch routes stall, `startup_observe=true` with direct startup uses an
asynchronous child solely to expose its owned PID. It takes at most one bounded
stack sample at ten seconds, keeps the 30-second deadline, and allows one second
for termination before killing only that child. The log omits sample headers and
binary-image paths. This changes the launch API and may perturb timing; its result
is observation evidence, not equivalent to the synchronous baseline.
To separately qualify the standard installer, use `consumer_installer=setup-bun`
and package mode. The pinned setup action downloads the same x64 binary with its
cache disabled and verifies its revision before the unchanged 30-second package
smoke. Its installation step is bounded to two minutes. This is an explicitly
installer-qualified test, not a cold-start comparison or release-promotion gate.
The diagnostic does not publish packages, promote a release or replace the original
consumer gate.
If no Bun entry marker appears, select `consumer_probe=startup` for a separate cold
run of import-free JavaScript under the same executable, environment filtering and
30-second limit. This probe skips package installation and cannot establish package
compatibility; it probes runtime startup and exit without package imports or file-based
module initialization.

Native CI also runs this smoke against its local root and platform tarballs on every target:
`node scripts/installed-smoke.mjs X.Y.Z --bun --tarballs root.tgz platform.tgz`.
FreeBSD uses Node only, as in the existing runtime proof. Local tarballs install once, with no
retry; the public release gate always uses the registry path.

All macOS jobs use xcode-27. The x64 addon is cross-built and tested under Rosetta,
including identity, census, package installation and explicit command-inspection refusal.
Native Intel command inspection remains supported but requires separate Intel hardware proof.
Native addon deployment targets remain macOS 10.12 for x64 and macOS 11.0 for ARM64,
and glibc 2.28 for Linux GNU (linked in a manylinux_2_28 container, then checked by symbol version);
Node.js keeps its own supported operating-system requirements.

Both macOS addon architectures receive ad-hoc code signatures before staging and
must pass `codesign --verify --strict`. These signatures validate Mach-O code
integrity; npm registry signatures and protected-tag provenance authenticate the publisher.

To build and verify all release packages on current main without creating a tag or
publishing, dispatch `release.yml` with the current package `version` and `dry_run=true`.
Manual runs reject publication and non-main source. The dry run includes all native
runtime and local installed-package checks, then assembles the complete package set.
