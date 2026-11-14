import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nativeTargets, hostNativeTarget, nativePackageDirectory, filesystemLauncherArtifact } from "./native-targets.mjs";
import { verifyWindowsRuntime, windowsRuntimeFlags } from "./windows-runtime.mjs";
const requested = process.argv[2];
const target = requested ? nativeTargets.find(t => t.rust === requested) : hostNativeTarget();
if (!target) throw new Error(`unsupported native build target: ${requested ?? process.platform + '-' + process.arch}`);
const root = new URL("../", import.meta.url);
const env = { ...process.env };
if (target.libc === "musl") env.RUSTFLAGS = `${env.RUSTFLAGS ?? ""} -C target-feature=-crt-static`.trim();
if (target.os === "win32") {
  // Keep the OS-serviced UCRT dynamic, but embed compiler-specific runtime support.
  if (env.CARGO_ENCODED_RUSTFLAGS !== undefined) {
    env.CARGO_ENCODED_RUSTFLAGS = [env.CARGO_ENCODED_RUSTFLAGS, ...windowsRuntimeFlags].filter(Boolean).join("\x1f");
  } else env.RUSTFLAGS = `${env.RUSTFLAGS ?? ""} ${windowsRuntimeFlags.join(" ")}`.trim();
}
execFileSync("cargo", ["build", "--workspace", "--locked", "--release", "--no-default-features", "--target", target.rust], { cwd: root, stdio: "inherit", env });
const library = target.os === "win32" ? "proc_safe_native.dll" : target.os === "darwin" ? "libproc_safe_native.dylib" : "libproc_safe_native.so";
const source = new URL(`target/${target.rust}/release/${library}`, root);
if (target.os === "darwin") {
  // The linker signs ARM64 implicitly; sign both architectures before staging identical bytes.
  execFileSync("codesign", ["--force", "--sign", "-", fileURLToPath(source)], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--strict", fileURLToPath(source)], { stdio: "inherit" });
}
if (target.os === "win32") verifyWindowsRuntime(readFileSync(source), target.cpu);
if (["failNextWindowsJobAssignment", "openWindowsPinWithoutDebug", "interceptNextWindowsJobInput"].some(name => readFileSync(source).includes(Buffer.from(name)))) {
  throw new Error("Refusing to stage a fault-injection addon in a platform package");
}
copyFileSync(source, new URL(`native/${target.artifact}`, root));
copyFileSync(source, new URL("proc-safe-native.node", nativePackageDirectory(target)));
const launcherArtifact = filesystemLauncherArtifact(target);
if (launcherArtifact) {
  const launcher = new URL(`target/${target.rust}/release/proc-safe-filesystem-launch`, root);
  for (const destination of [new URL(`native/${launcherArtifact}`, root), new URL("proc-safe-filesystem-launch", nativePackageDirectory(target))]) {
    copyFileSync(launcher, destination);
    chmodSync(destination, 0o755);
  }
}
console.log(`Built and staged ${target.label}`);
