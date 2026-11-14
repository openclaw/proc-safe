# Contributing

Use Node.js 22 or newer, the pnpm version in package.json, and Rust 1.88 or newer.
A platform C linker is required. On Windows use the Visual Studio build tools;
on macOS use the Xcode command-line tools. No archive or compression toolchain is needed.

```sh
pnpm install --frozen-lockfile
pnpm native:build
PROC_SAFE_NATIVE=require pnpm check
cargo clippy --workspace --locked -- -D warnings
cargo test --workspace --locked
pnpm package:smoke
```

Windows PowerShell: set `$env:PROC_SAFE_NATIVE = 'require'` before running checks.
Build distributable bindings through `pnpm native:build`, not bare Cargo: the Windows
producer links compiler support statically and the OS UCRT dynamically, and verifies
the resulting PE dependencies before staging.
Build the separate 32-bit Windows inspection fixture with
`node scripts/build-windows-inspect-fixture.mjs` after installing the
`i686-pc-windows-msvc` Rust target. It shares the Windows linkage policy and
verifies the resulting executable's imports; bare `rustc` defaults would
reintroduce a VC redistributable prerequisite.
See [native architecture](docs/native.md) and [release prerequisites](RELEASE-PREREQS.md).

Keep each new capability in one TypeScript subpath and one Rust module. Name capabilities,
not syscalls. Public APIs, failure codes, time units, exports, documentation, and changelog
entries must agree. Test actual operating-system boundaries on both the main thread and a
real Worker. Keep policy, retries, and shell tools outside this package.

Use Conventional Commits and explain behavior and proof in pull requests. Follow the
[Code of Conduct](CODE_OF_CONDUCT.md); disclose vulnerabilities through [SECURITY.md](SECURITY.md).
