import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

export async function withSystemdFixture(prove) {
  const directory = await mkdtemp(join(tmpdir(), "proc-systemd-"));
  const socket = join(directory, "socket");
  const binary = join(directory, "peer");
  let child;
  const stalledSockets = new Set();
  const stalled = createServer(socket => { stalledSockets.add(socket); socket.on("close", () => stalledSockets.delete(socket)); });
  try {
    stalled.listen(join(directory, "stalled"));
    await once(stalled, "listening");
    execFileSync("cc", ["-D_GNU_SOURCE", "-Wall", "-Wextra", "-Werror", "test/fixtures/systemd-peer.c", "-o", binary, "-lsystemd", "-lpthread"], { stdio: "inherit" });
    child = spawn(binary, [socket], { stdio: ["ignore", "pipe", "inherit"] });
    await Promise.race([
      once(child.stdout, "data").then(([data]) => { if (!data.toString().includes("READY")) throw new Error("peer did not start"); }),
      once(child, "exit").then(([code]) => { throw new Error(`peer exited ${code}`); }),
    ]);
    const uid = process.geteuid();
    return await prove({ fixtureAddress: `unix:path=${socket}`, fixturePid: child.pid, stalledAddress: `unix:path=${join(directory, "stalled")}`,
      managerAddress: `unix:path=/run/user/${uid}/systemd/private`,
      brokerAddress: `unix:path=/run/user/${uid}/bus`, unit: process.env.PROC_SAFE_SYSTEMD_UNIT,
      machine: process.env.PROC_SAFE_SYSTEMD_MACHINE });
  } finally {
    for (const socket of stalledSockets) socket.destroy();
    await new Promise(resolve => stalled.close(resolve));
    if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
    await rm(directory, { recursive: true, force: true });
  }
}
