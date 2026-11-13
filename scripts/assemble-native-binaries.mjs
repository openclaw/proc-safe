import { chmodSync, copyFileSync, statSync } from "node:fs";
import { nativeTargets, nativePackageDirectory, filesystemLauncherArtifact } from "./native-targets.mjs";
for (const target of nativeTargets) {
  const source = new URL(`../artifacts/${target.artifact}`, import.meta.url);
  if (statSync(source).size === 0) throw new Error(`${target.artifact} is empty`);
  copyFileSync(source, new URL("proc-safe-native.node", nativePackageDirectory(target)));
  const launcherArtifact = filesystemLauncherArtifact(target);
  if (launcherArtifact) {
    const launcher = new URL(`../artifacts/${launcherArtifact}`, import.meta.url);
    if (statSync(launcher).size === 0) throw new Error(`${launcherArtifact} is empty`);
    const destination = new URL("proc-safe-filesystem-launch", nativePackageDirectory(target));
    copyFileSync(launcher, destination);
    // GitHub artifact transport does not retain executable modes.
    chmodSync(destination, 0o755);
  }
}
