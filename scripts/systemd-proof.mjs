import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { prove, proveFlood, FLOOD_SIGNAL_COUNT } from "./systemd-proof-client.mjs";
import { withSystemdFixture } from "./systemd-proof-fixture.mjs";

const scenario = process.argv[2] ?? "all";
const signals = process.argv[3] === undefined ? FLOOD_SIGNAL_COUNT : Number(process.argv[3]);
if (!["all", "main", "worker", "flood", "worker-flood"].includes(scenario)) throw new Error("invalid systemd proof scenario");
if (!Number.isSafeInteger(signals) || signals < 0) throw new Error("invalid signal count");
async function inWorker(input, scenario) {
  const worker = new Worker(new URL("./systemd-proof-client.mjs", import.meta.url), { workerData: { ...input, scenario, signals } });
  const [[result], [code]] = await Promise.all([once(worker, "message"), once(worker, "exit")]);
  if (code !== 0) throw new Error(`worker exited ${code}`);
  return result.passed;
}
const started = performance.now();
try {
  const result = await withSystemdFixture(async input => {
    if (["all", "main", "worker"].includes(scenario) && !input.unit) throw new Error("PROC_SAFE_SYSTEMD_UNIT must identify a real active user unit");
    if (scenario === "main") return { passed: await prove(input) };
    if (scenario === "worker") return { passed: await inWorker(input, "worker") };
    if (scenario === "flood") return { passed: await proveFlood(input, signals), signals };
    if (scenario === "worker-flood") return { passed: await inWorker(input, "worker-flood"), signals };
    return { mainPassed: await prove(input), workerPassed: await inWorker(input, "worker"),
      floodPassed: await proveFlood(input, signals), workerFloodPassed: await inWorker(input, "worker-flood"), signals };
  });
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, runtime: process.versions.bun ? "bun" : "node", scenario,
    ...result, durationMs: performance.now() - started }));
} catch (error) {
  console.log(JSON.stringify({ scenario, signals, code: error.code, dbusErrorName: error.details?.dbusErrorName,
    completedSignals: error.completedSignals, durationMs: performance.now() - started }));
  throw error;
}
