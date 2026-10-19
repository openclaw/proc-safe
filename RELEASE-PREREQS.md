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
xcode-27 (ARM64), macos-26-intel, ubuntu-latest, ubuntu-24.04-arm, windows-latest, and
windows-11-arm. Each runner checks its architecture and the exact matching native package,
imports every exported subpath, and runs supported read-only calls with default optional
settings on Node 24 and Bun, both on the main thread and in a Worker. It includes a full default
ancestry walk, self command inspection, Darwin coalition, Windows census and process pin,
Linux wait-state and temporary-file residency, plus every capability's `isSupported()`.
Systemd is probed only with `isSupported()`; no service connection or process mutation is made.

Run the same public-registry smoke locally with `node scripts/installed-smoke.mjs X.Y.Z --bun`
(omit `--bun` for Node only). Installation uses an isolated cache and empty npm configuration.
Only installation retries: five attempts, with 5/10/20/40-second backoff, a 30-second fetch
timeout and a 120-second ceiling per attempt. A successful install's behavioral failure is
terminal. Failure leaves the GitHub Release draft intact and never deletes or republishes a
package. Re-run the failed gate after investigation; publication retries still verify existing
versions rather than republish them.

Native CI also runs this smoke against its local root and platform tarballs on every target:
`node scripts/installed-smoke.mjs X.Y.Z --bun --tarballs root.tgz platform.tgz`.
FreeBSD uses Node only, as in the existing runtime proof. Local tarballs install once, with no
retry; the public release gate always uses the registry path.

The Intel runner is required for the native x64 command-inspection contract: Rosetta
deliberately reports that capability as unsupported. ARM64 CI separately verifies that refusal.
Native addon deployment targets remain macOS 10.12 for x64 and macOS 11.0 for ARM64;
Node.js keeps its own supported operating-system requirements.

To build and verify all release packages on current main without creating a tag or
publishing, dispatch `release.yml` with the current package `version` and `dry_run=true`.
Manual runs reject publication and non-main source. The dry run includes all native
runtime and local installed-package checks, then assembles the complete package set.
