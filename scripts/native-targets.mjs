export const nativeTargets = [
  {
    "label": "linux-x64-gnu",
    "package": "@openclaw/proc-safe-linux-x64-gnu",
    "os": "linux",
    "cpu": "x64",
    "libc": "glibc",
    "rust": "x86_64-unknown-linux-gnu",
    "artifact": "proc-safe-native.linux-x64-gnu.node"
  },
  {
    "label": "linux-x64-musl",
    "package": "@openclaw/proc-safe-linux-x64-musl",
    "os": "linux",
    "cpu": "x64",
    "libc": "musl",
    "rust": "x86_64-unknown-linux-musl",
    "artifact": "proc-safe-native.linux-x64-musl.node"
  },
  {
    "label": "linux-arm64-gnu",
    "package": "@openclaw/proc-safe-linux-arm64-gnu",
    "os": "linux",
    "cpu": "arm64",
    "libc": "glibc",
    "rust": "aarch64-unknown-linux-gnu",
    "artifact": "proc-safe-native.linux-arm64-gnu.node"
  },
  {
    "label": "linux-arm64-musl",
    "package": "@openclaw/proc-safe-linux-arm64-musl",
    "os": "linux",
    "cpu": "arm64",
    "libc": "musl",
    "rust": "aarch64-unknown-linux-musl",
    "artifact": "proc-safe-native.linux-arm64-musl.node"
  },
  {
    "label": "darwin-x64",
    "package": "@openclaw/proc-safe-darwin-x64",
    "os": "darwin",
    "cpu": "x64",
    "rust": "x86_64-apple-darwin",
    "artifact": "proc-safe-native.darwin-x64.node"
  },
  {
    "label": "darwin-arm64",
    "package": "@openclaw/proc-safe-darwin-arm64",
    "os": "darwin",
    "cpu": "arm64",
    "rust": "aarch64-apple-darwin",
    "artifact": "proc-safe-native.darwin-arm64.node"
  },
  {
    "label": "win32-x64-msvc",
    "package": "@openclaw/proc-safe-win32-x64-msvc",
    "os": "win32",
    "cpu": "x64",
    "rust": "x86_64-pc-windows-msvc",
    "artifact": "proc-safe-native.win32-x64-msvc.node"
  },
  {
    "label": "win32-arm64-msvc",
    "package": "@openclaw/proc-safe-win32-arm64-msvc",
    "os": "win32",
    "cpu": "arm64",
    "rust": "aarch64-pc-windows-msvc",
    "artifact": "proc-safe-native.win32-arm64-msvc.node"
  },
  {
    "label": "freebsd-x64",
    "package": "@openclaw/proc-safe-freebsd-x64",
    "os": "freebsd",
    "cpu": "x64",
    "rust": "x86_64-unknown-freebsd",
    "artifact": "proc-safe-native.freebsd-x64.node"
  },
  {
    "label": "freebsd-arm64",
    "package": "@openclaw/proc-safe-freebsd-arm64",
    "os": "freebsd",
    "cpu": "arm64",
    "rust": "aarch64-unknown-freebsd",
    "artifact": "proc-safe-native.freebsd-arm64.node"
  }
];
export function nativePackageDirectory(target) {
  return new URL(`../packages/${target.label}/`, import.meta.url);
}
export function hostNativeTarget() {
  const base = `${process.platform}-${process.arch}`;
  const suffix = process.platform === "win32" ? "-msvc" : process.platform === "linux" ? (process.report?.getReport().header?.glibcVersionRuntime ? "-gnu" : "-musl") : "";
  return nativeTargets.find(target => target.label === base + suffix);
}
