import { execFileSync } from "node:child_process";
const count = 10;
for (const name of ["identity", "darwin", "reaper", "diagnostics", "test-support", "systemd"]) {
  const times = Array.from({ length: count }, () => Number(execFileSync(process.execPath, ["--input-type=module", "-e", `
    const start = performance.now();
    await import('./dist/${name}.js');
    console.log(performance.now() - start);
  `], { encoding: "utf8" })));
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ runtime: process.versions.bun ? "bun" : "node", version: process.versions.bun ?? process.version, subpath: name, samples: count, medianMs: times[Math.floor(count / 2)], minMs: times[0], maxMs: times.at(-1) }));
}
