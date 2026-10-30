import { copyFileSync, statSync } from "node:fs";
import { nativeTargets, nativePackageDirectory } from "./native-targets.mjs";
for (const target of nativeTargets) {
  const source = new URL(`../artifacts/${target.artifact}`, import.meta.url);
  if (statSync(source).size === 0) throw new Error(`${target.artifact} is empty`);
  copyFileSync(source, new URL("proc-safe-native.node", nativePackageDirectory(target)));
  if (target.os === "win32") {
    const launcher = new URL(`../artifacts/proc-safe-spawn.${target.label}.exe`, import.meta.url);
    if (statSync(launcher).size === 0) throw new Error(`${target.label} launcher is empty`);
    copyFileSync(launcher, new URL("proc-safe-spawn.exe", nativePackageDirectory(target)));
  }
}
