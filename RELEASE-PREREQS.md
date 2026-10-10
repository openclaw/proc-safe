# Release prerequisites

Publishing is protected-tag-driven through `.github/workflows/release.yml` using npm trusted
publishing. No local publication, token fallback, or npm settings change is part of development.

Eleven packages must exist in npm with GitHub Actions trusted publishers: `@openclaw/proc-safe`
and each of the ten names in `scripts/native-targets.mjs`. Configure organization `openclaw`,
repository `proc-safe`, workflow `release.yml`, and no environment. Maintainers require 2FA.
Initial package creation and publisher setup need a separate explicit authorization.

Before release, resolve the FreeBSD identity contract and pass every native runtime gate.
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
successful verification promotes the draft. Confirm finalized changelog/release-body agreement,
public release and annotated tag, dist-tags, publication times, and all eleven package records.
Leave clean synchronized main and follow the repository's Unreleased convention.
