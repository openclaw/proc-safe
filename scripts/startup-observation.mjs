import { spawn, execFile } from "node:child_process";
import { readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

// Only the caller's tracked child is sampled or signalled. A timeout stays a failure.
export async function observeStartup(command, args, {
  cwd, env, sample, timeoutMs = 30000, sampleDelayMs = 10000, killGraceMs = 1000,
}) {
  const started = performance.now();
  const child = spawn(command, args, { cwd, env, stdio: "inherit" });
  let exited = false;
  let timedOut = false;
  let killTimer;
  let observation = Promise.resolve({ status: "not-sampled" });
  const completion = new Promise(resolve => {
    child.once("error", error => {
      exited = true;
      resolve({ code: null, signal: null, spawnError: String(error.code ?? "unknown") });
    });
    child.once("exit", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  const sampleTimer = setTimeout(() => {
    if (!exited) {
      observation = Promise.resolve().then(() => sample(child.pid))
        .catch(error => ({ status: "failed", errorCode: String(error.code ?? "unknown") }));
    }
  }, sampleDelayMs);
  const deadline = setTimeout(() => {
    if (exited) return;
    timedOut = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, killGraceMs);
  }, timeoutMs);
  const result = await completion;
  const elapsedMs = performance.now() - started;
  clearTimeout(sampleTimer);
  clearTimeout(deadline);
  clearTimeout(killTimer);
  return { ...result, timedOut, elapsedMs, sample: await observation };
}

export async function sampleStartup(pid, directory) {
  const path = join(directory, "startup-sample.txt");
  try {
    await new Promise((resolve, reject) => {
      execFile("/usr/bin/sample", [String(pid), "1", "1", "-file", path], {
        timeout: 5000, killSignal: "SIGKILL", maxBuffer: 65536,
      }, error => error ? reject(error) : resolve());
    });
    if (statSync(path).size > 1048576) return { status: "too-large" };
    const callGraph = formatCallGraph(readFileSync(path, "utf8"));
    if (callGraph === null) return { status: "no-call-graph" };
    return { status: "sampled", callGraph };
  } finally {
    rmSync(path, { force: true });
  }
}

export function formatCallGraph(text) {
  const start = text.indexOf("Call graph:");
  if (start < 0) return null;
  const graph = text.slice(start + "Call graph:".length).split(/\n(?:Binary Images:|Total number in stack)/)[0];
  const lines = graph.split("\n").slice(0, 160);
  return lines.join("\n").replace(/(?:[A-Za-z]:[\\/]|\/)[^\s)]+/g, "<path>").slice(0, 32768);
}
