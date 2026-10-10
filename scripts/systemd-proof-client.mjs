import assert from "node:assert/strict";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import { SystemdBus, isSupported } from "../dist/systemd.js";
import { ProcSafeError } from "../dist/errors.js";

export async function prove({ fixtureAddress, fixturePid, stalledAddress, managerAddress, brokerAddress, unit, machine }) {
  let passed = 0;
  const same = (actual, expected) => { assert.deepEqual(actual, expected); passed++; };
  const fails = async (operation, code) => { await assert.rejects(operation, e => e instanceof ProcSafeError && e.code === code); passed++; };
  const options = { timeoutMs: 2000 };
  same(isSupported(), true);
  await fails(() => SystemdBus.connectPrivatePeer(stalledAddress, { timeoutMs: 25 }), "timeout");
  const bus = await SystemdBus.connectPrivatePeer(fixtureAddress, options);
  same(bus.peer, { pid: fixturePid, uid: process.geteuid() });
  same(Object.isFrozen(bus) && Object.isFrozen(bus.peer), true);
  const at = member => ({ path: "/fixture", interface: "org.example.ProcSafe", member });
  try {
    for (const [name, signature, expected] of [
      ["Text", "s", "fixture"], ["Path", "o", "/fixture"], ["Unsigned", "u", 4294967295],
      ["Signed", "i", -2147483648], ["Big", "t", 18446744073709551615n], ["Flag", "b", true],
      ["Strings", "as", ["", "two"]], ["Condition", "(sb)", ["condition", true]],
      ["Process", "(sus)", ["unit", 4294967295, "process"]],
      ["Exec", "a(sasbttttuii)", [["/fixture", ["a", "b"], false, 1n, 2n, 3n, 18446744073709551615n, 4294967295, -2147483648, 2147483647]]],
    ]) same(await bus.getProperty(at(name), signature, options), expected);
    same(await bus.call(at("Echo"), [{ type: "s", value: "echo" }], options), ["echo"]);
    same(await bus.call(at("Big"), [], options), [18446744073709551615n]);
    same(await bus.call(at("Nothing"), [], options), []);
    same(await bus.call(at("Scalars"), [
      { type: "s", value: "value" }, { type: "o", value: "/fixture" }, { type: "u", value: 4294967295 },
      { type: "i", value: -2147483648 }, { type: "t", value: 18446744073709551615n }, { type: "b", value: true },
    ], options), [true]);
    await fails(() => bus.call(at("Deny"), [], options), "access-denied");
    await assert.rejects(() => bus.call(at("Missing"), [], options), e => e.details?.dbusErrorName === "org.freedesktop.systemd1.NoSuchUnit"); passed++;
    await fails(() => bus.getProperty(at("Text"), "u", options), "layout-mismatch");
    await fails(() => bus.call(at("Large"), [], { ...options, replyBudgetBytes: 32 }), "incomplete");
    await fails(() => bus.getProperty(at("Exec"), "a(sasbttttuii)", { ...options, replyBudgetBytes: 32 }), "incomplete");
    // The wire remains usable after a property, remote error, or decode-budget failure.
    same(await bus.call(at("Echo"), [{ type: "s", value: "alive" }], options), ["alive"]);
    let timerRan = false;
    const pending = bus.call(at("Delay"), [{ type: "u", value: 150 }], options);
    const timer = delay(10).then(() => { timerRan = true; });
    await fails(() => bus.call(at("Increment"), [], { timeoutMs: 25 }), "timeout");
    same(timerRan, true);
    same(await pending, ["delayed"]); await timer;
    same(await bus.call(at("Count"), [], options), [0]);
    await fails(() => bus.call(at("Delay"), [{ type: "u", value: 100 }], { timeoutMs: 20 }), "timeout");
    await delay(120);
    same(await bus.call(at("Echo"), [{ type: "s", value: "after timeout" }], options), ["after timeout"]);
    const final = bus.call(at("Delay"), [{ type: "u", value: 40 }], options);
    const closing = bus.close();
    same(bus.close(), closing);
    await fails(() => bus.call(at("Echo"), [], options), "operation-failed");
    same(await final, ["delayed"]); await closing;
    await bus[Symbol.asyncDispose](); passed++;
  } finally { await bus.close(); }
  await fails(() => SystemdBus.connectPrivatePeer("unix:path=/nonexistent/proc-safe", options), "operation-failed");
  const manager = await SystemdBus.connectUserManager(managerAddress, options);
  try {
    same(manager.peer.uid, process.geteuid());
    assert.ok(manager.peer.pid > 0); passed++;
    const target = { path: "/org/freedesktop/systemd1", interface: "org.freedesktop.systemd1.Manager", member: "Version" };
    const version = await manager.getProperty(target, "s", options);
    assert.ok(typeof version === "string" && version.length > 0); passed++;
    const [path] = await manager.call({ ...target, member: "GetUnit" }, [{ type: "s", value: unit }], options);
    assert.match(path, /^\/org\/freedesktop\/systemd1\/unit\//); passed++;
    const state = await manager.getProperty({ path, interface: "org.freedesktop.systemd1.Unit", member: "ActiveState" }, "s", options);
    same(state, "active");
  } finally { await manager.close(); }
  const broker = await SystemdBus.connectBroker(brokerAddress, options);
  try {
    same("peer" in broker, false);
    const target = { destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "GetId" };
    const [id] = await broker.call(target, [], options); assert.match(id, /^[a-f0-9]{32}$/); passed++;
    await assert.rejects(() => broker.call({ ...target, destination: "org.example.ProcSafe.DoesNotExist" }, [], options), e => e.details?.dbusErrorName === "org.freedesktop.DBus.Error.NameHasNoOwner"); passed++;
  } finally { await broker.close(); }
  if (machine) {
    const mediated = await SystemdBus.connectMachineBroker(machine, options);
    try { same("peer" in mediated, false); same((await mediated.call({ destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "GetId" }, [], options)).length, 1); }
    finally { await mediated.close(); }
  }
  return passed;
}
// libsystemd 259.5 first fails at 393,216 undrained signals; add an 8,192-signal batch.
export const FLOOD_SIGNAL_COUNT = 401_408;

export async function proveFlood({ fixtureAddress, fixturePid }, signals = FLOOD_SIGNAL_COUNT) {
  const bus = await SystemdBus.connectPrivatePeer(fixtureAddress, { timeoutMs: 2000 });
  let completedSignals = 0;
  let passed = 0;
  const target = { path: "/fixture", interface: "org.example.ProcSafe", member: "Flood" };
  try {
    assert.deepEqual(bus.peer, { pid: fixturePid, uid: process.geteuid() }); passed++;
    while (completedSignals < signals) {
      const count = Math.min(8192, signals - completedSignals);
      assert.deepEqual(await bus.call(target, [{ type: "u", value: count }], { timeoutMs: 2000 }), [count]);
      completedSignals += count;
      passed++;
    }
    assert.deepEqual(await bus.call({ ...target, member: "Echo" }, [{ type: "s", value: "after flood" }], { timeoutMs: 2000 }), ["after flood"]); passed++;
    return passed;
  } catch (error) {
    error.completedSignals = completedSignals;
    throw error;
  } finally { await bus.close(); }
}
if (!isMainThread) {
  try { parentPort.postMessage({ passed: workerData.scenario === "worker-flood" ? await proveFlood(workerData, workerData.signals) : await prove(workerData) }); }
  catch (error) { throw error; }
}
