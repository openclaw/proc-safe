import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const binaryAsset = /\.(?:jpe?g|png|gif|webp|ico)$/i;
for (const file of [...walk("src"), ...walk("native/src"), ...walk("test"), ...walk("docs")].filter(f => !binaryAsset.test(f))) {
  const text = readFileSync(file, "utf8");
  assert.ok(!/[\t ]+$/m.test(text), `${file}: trailing whitespace`);
  assert.ok(text.endsWith("\n"), `${file}: missing final newline`);
}
for (const file of walk("src")) {
  assert.ok(!/node:child_process|\b(?:execSync|spawnSync)\b/.test(readFileSync(file, "utf8")), `${file}: shell fallback`);
}
console.log("Source formatting and native boundary checks passed");
