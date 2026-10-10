import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { nativeTargets } from "./native-targets.mjs";
import { mapReleasePairs } from "./map-release-pairs.mjs";
import { publishOrVerify } from "./publish-or-verify.mjs";

export async function publishReleasePackages({
  artifactsDir = "release-artifacts",
  publish = publishOrVerify,
} = {}) {
  const directory = resolve(artifactsDir);
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  if (!Array.isArray(manifest) || manifest.length < 2) {
    throw new Error("release manifest must contain platform packages and the root package");
  }
  const rootPackages = manifest.filter((entry) => entry?.name === "@openclaw/proc-safe");
  if (rootPackages.length !== 1) {
    throw new Error("release manifest must contain exactly one @openclaw/proc-safe package");
  }
  const platformPackages = manifest.filter((entry) => entry?.name !== "@openclaw/proc-safe");
  const expected = new Set(nativeTargets.map(target => target.package));
  if (platformPackages.length !== expected.size || platformPackages.some(entry => !expected.delete(entry.name)) || expected.size) {
    throw new Error("release manifest must contain each of the ten platform packages exactly once");
  }
  await mapReleasePairs(platformPackages, artifact => publish({ packageName: artifact.name, artifactsDir: directory }));
  await publish({ packageName: rootPackages[0].name, artifactsDir: directory });
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPath === import.meta.url) {
  await publishReleasePackages({ artifactsDir: process.argv[2] });
}
