import assert from "node:assert/strict";
import { once } from "node:events";
import { isMainThread, Worker, workerData, parentPort } from "node:worker_threads";
import { SystemdBus } from "../dist/systemd.js";

async function prove({ username, uid }) {
  assert.equal(process.geteuid(), 0, "cross-user bridge proof runs as root on an isolated runner");
  assert.ok(uid > 0, "the destination must be a different, non-root account");
  await assert.rejects(() => SystemdBus.connectUserManager(`unix:path=/run/user/${uid}/systemd/private`, { timeoutMs: 2000 }), { code: "access-denied" });
  const bus = await SystemdBus.connectMachineBroker(`${username}@.host`, { timeoutMs: 5000 });
  try {
    assert.equal("peer" in bus, false);
    const target = { destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "GetNameOwner" };
    const [owner] = await bus.call(target, [{ type: "s", value: "org.freedesktop.systemd1" }], { timeoutMs: 2000 });
    assert.match(owner, /^:[0-9]+\.[0-9]+$/);
    const [ownerUid] = await bus.call({ ...target, member: "GetConnectionUnixUser" }, [{ type: "s", value: owner }], { timeoutMs: 2000 });
    assert.equal(ownerUid, uid);
    return 4;
  } finally { await bus.close(); }
}
if (isMainThread) {
  const input = { username: process.argv[2], uid: Number(process.argv[3]) };
  const mainPassed = await prove(input);
  const worker = new Worker(new URL(import.meta.url), { workerData: input });
  const ended = once(worker, "exit");
  const [workerPassed] = await once(worker, "message");
  assert.deepEqual(await ended, [0]);
  console.log(JSON.stringify({ bridge: "cross-user", mainPassed, workerPassed }));
} else {
  parentPort.postMessage(await prove(workerData));
}
