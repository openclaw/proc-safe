import { expectTypeOf } from "vitest";
import { SystemdBus } from "../src/systemd.js";
import type { SystemdConnectOptions, SystemdCallOptions, SystemdSignature, SystemdTarget, SystemdValue, SystemdValueFor } from "../src/systemd.js";

expectTypeOf<keyof SystemdConnectOptions>().toEqualTypeOf<"timeoutMs">();
expectTypeOf<SystemdConnectOptions>().toEqualTypeOf<{ readonly timeoutMs: number }>();
for (const factory of ["connectUserManager", "connectBroker", "connectMachineBroker", "connectPrivatePeer"] as const) {
  expectTypeOf<Parameters<typeof SystemdBus[typeof factory]>[1]>().toEqualTypeOf<SystemdConnectOptions>();
  SystemdBus[factory]("address", { timeoutMs: 1000 });
  // @ts-expect-error Connection factories do not accept a reply budget.
  SystemdBus[factory]("address", { timeoutMs: 1000, replyBudgetBytes: 1024 });
}

type ExpectedValues = {
  s: string;
  o: string;
  u: number;
  i: number;
  t: bigint;
  b: boolean;
  "(sb)": readonly [string, boolean];
  "(sus)": readonly [string, number, string];
  "(sasbttttuii)": readonly [string, readonly string[], boolean, bigint, bigint, bigint, bigint, number, number, number];
};
type ExpectedProperties = ExpectedValues & {
  [Signature in keyof ExpectedValues as `a${Signature}`]: readonly ExpectedValues[Signature][];
};
type ActualProperties = { [Signature in SystemdSignature]: SystemdValueFor<Signature> };
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
expectTypeOf<Equal<ActualProperties, { [Signature in keyof ExpectedProperties]: ExpectedProperties[Signature] }>>().toEqualTypeOf<true>();

declare const bus: SystemdBus;
declare const target: SystemdTarget;
const options = { timeoutMs: 1000 };
expectTypeOf(bus.getProperty(target, "t", options)).toEqualTypeOf<Promise<bigint>>();
expectTypeOf(bus.getProperty(target, "s", options)).toEqualTypeOf<Promise<string>>();
expectTypeOf(bus.getProperty(target, "b", options)).toEqualTypeOf<Promise<boolean>>();
expectTypeOf(bus.getProperty(target, "(sb)", options)).toEqualTypeOf<Promise<readonly [string, boolean]>>();
expectTypeOf(bus.getProperty(target, "a(sus)", options)).toEqualTypeOf<Promise<readonly (readonly [string, number, string])[]>>();
expectTypeOf(bus.getProperty(target, "at", options)).toEqualTypeOf<Promise<readonly bigint[]>>();
declare const scalarUnion: "s" | "t";
expectTypeOf(bus.getProperty(target, scalarUnion, options)).toEqualTypeOf<Promise<string | bigint>>();
declare const signature: SystemdSignature;
expectTypeOf(bus.getProperty(target, signature, options)).toEqualTypeOf<Promise<SystemdValueFor<SystemdSignature>>>();
expectTypeOf<SystemdValueFor<SystemdSignature>>().toExtend<SystemdValue>();
expectTypeOf(bus.call(target, [], options)).toEqualTypeOf<Promise<SystemdValue>>();
const callOptions: SystemdCallOptions = { timeoutMs: 1000, replyBudgetBytes: 1024 };
expectTypeOf(bus.getProperty(target, "t", callOptions)).toEqualTypeOf<Promise<bigint>>();
expectTypeOf(bus.call(target, [], callOptions)).toEqualTypeOf<Promise<SystemdValue>>();
// @ts-expect-error Unsupported signatures must still be rejected at compile time.
bus.getProperty(target, "v", options);
// @ts-expect-error Type arguments cannot override the supplied wire signature.
bus.getProperty<"s">(target, "t", options);
