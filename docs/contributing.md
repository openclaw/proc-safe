# Development

See [CONTRIBUTING.md](../CONTRIBUTING.md) for build commands and [native.md](native.md)
for platform mechanisms. Each new subpath must stay importable everywhere without native
initialization. Keep native Rust functions private to the addon and expose named TypeScript
capabilities with stable errors. Future inspection, supervision, and service-manager capabilities
belong in separate subpaths rather than an expanding identity module.
