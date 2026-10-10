import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { nativeTargets, hostNativeTarget, nativePackageDirectory } from "./native-targets.mjs";
const requested = process.argv[2];
const target = requested ? nativeTargets.find(t => t.rust === requested) : hostNativeTarget();
if (!target) throw new Error(`unsupported native build target: ${requested ?? process.platform + '-' + process.arch}`);
const root = new URL("../", import.meta.url);
const env = { ...process.env };
if (target.libc === "musl") env.RUSTFLAGS = `${env.RUSTFLAGS ?? ""} -C target-feature=-crt-static`.trim();
execFileSync("cargo", ["build", "--workspace", "--locked", "--release", "--no-default-features", "--target", target.rust], { cwd: root, stdio: "inherit", env });
const library = target.os === "win32" ? "proc_safe_native.dll" : target.os === "darwin" ? "libproc_safe_native.dylib" : "libproc_safe_native.so";
const source = new URL(`target/${target.rust}/release/${library}`, root);
if (readFileSync(source).includes(Buffer.from("failNextWindowsJobAssignment"))) {
  throw new Error("Refusing to stage a fault-injection addon in a platform package");
}
copyFileSync(source, new URL(`native/${target.artifact}`, root));
copyFileSync(source, new URL("proc-safe-native.node", nativePackageDirectory(target)));
console.log(`Built and staged ${target.label}`);
