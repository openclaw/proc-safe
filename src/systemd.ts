import { ProcSafeError } from "./errors.js";
import { fromNativeError } from "./native-error.js";
import { getNativeBinding } from "./native.js";
import type { NativeSystemdBus } from "./native-binding.js";

export type SystemdPeer = { readonly pid: number; readonly uid: number };
export type SystemdConnectOptions = { readonly timeoutMs: number };
export type SystemdCallOptions = { readonly timeoutMs: number; readonly replyBudgetBytes?: number };
type ScalarSignature = "s" | "o" | "u" | "i" | "t" | "b";
type StructSignature = "(sb)" | "(sus)" | "(sasbttttuii)";
export type SystemdSignature = ScalarSignature | StructSignature | `a${ScalarSignature | StructSignature}`;
type SignatureValues = {
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
/** The decoded property value for a supported D-Bus signature. */
export type SystemdValueFor<Signature extends SystemdSignature> =
  Signature extends keyof SignatureValues ? SignatureValues[Signature]
    : Signature extends `a${infer ElementSignature extends keyof SignatureValues}` ? readonly SignatureValues[ElementSignature][]
      : never;
type Scalar = string | number | bigint | boolean;
type Struct = readonly [string, boolean] | readonly [string, number, string]
  | readonly [string, readonly string[], boolean, bigint, bigint, bigint, bigint, number, number, number];
type Element = Scalar | Struct | readonly Scalar[] | readonly Struct[];
/** Properties return their value; method calls return a zero- or one-element reply tuple. */
export type SystemdValue = Element | readonly [] | readonly [Element];
export type SystemdArg =
  | { readonly type: "s" | "o"; readonly value: string }
  | { readonly type: "u" | "i"; readonly value: number }
  | { readonly type: "t"; readonly value: bigint }
  | { readonly type: "b"; readonly value: boolean };
export type SystemdTarget = {
  /** Required for brokers; omitted for a direct manager peer. */
  readonly destination?: string;
  readonly path: string;
  readonly interface: string;
  readonly member: string;
};

const constructorKey = Symbol("systemd owner");
function invalid(message: string): never { throw new ProcSafeError("invalid-argument", message); }
function text(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) invalid(`${name} must be a nonempty NUL-free string`);
}
function validateOptions(value: SystemdCallOptions): number {
  if (!value || !Number.isFinite(value.timeoutMs) || value.timeoutMs <= 0) invalid("timeoutMs must be finite and positive");
  const budget = value.replyBudgetBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(budget) || budget < 1) invalid("replyBudgetBytes must be a positive safe integer");
  return budget;
}
function validateTarget(value: SystemdTarget): void {
  if (!value) invalid("target is required");
  text(value.path, "path"); text(value.interface, "interface"); text(value.member, "member");
  if (value.destination !== undefined) text(value.destination, "destination");
}
const signatures = new Set<string>(["s", "o", "u", "i", "t", "b", "(sb)", "(sus)", "(sasbttttuii)"].flatMap(s => [s, `a${s}`]));

export interface AuthenticatedSystemdBus extends SystemdBus { readonly peer: SystemdPeer }

/** A single native-owned sd-bus connection. Calls run in submission order. */
export class SystemdBus implements AsyncDisposable {
  readonly #native: NativeSystemdBus;
  #closing?: Promise<void>;
  private constructor(key: symbol, native: NativeSystemdBus) {
    if (key !== constructorKey) invalid("use a SystemdBus connection factory");
    this.#native = native;
  }

  static async #connect(mode: string, address: string, options: SystemdConnectOptions): Promise<SystemdBus> {
    validateOptions(options); text(address, mode === "machine" ? "machine" : "address");
    if (process.platform !== "linux") throw new ProcSafeError("unsupported-platform", "systemd is supported only on Linux");
    const connect = getNativeBinding()?.connectSystemd;
    if (!connect) throw new ProcSafeError("helper-unavailable", "native systemd support is unavailable");
    try {
      const native = await connect(mode, address, options.timeoutMs);
      const bus = new SystemdBus(constructorKey, native);
      if (mode === "private" || mode === "user") {
        if (!Number.isInteger(native.peerPid) || native.peerPid! <= 0 || !Number.isInteger(native.peerUid) || native.peerUid! < 0 || native.peerUid! >= 0xffffffff) {
          await native.close();
          throw new ProcSafeError("layout-mismatch", "native systemd peer credentials are incomplete");
        }
        Object.defineProperty(bus, "peer", { value: Object.freeze({ pid: native.peerPid, uid: native.peerUid }), enumerable: true });
      }
      Object.freeze(bus);
      return bus;
    } catch (error) { throw fromNativeError(error); }
  }

  /** Direct private user-manager socket, authenticated just like the existing private-peer route. */
  static async connectUserManager(address: string, options: SystemdConnectOptions): Promise<AuthenticatedSystemdBus> {
    return await this.#connect("user", address, options) as AuthenticatedSystemdBus;
  }
  static async connectBroker(address: string, options: SystemdConnectOptions): Promise<SystemdBus> {
    return await this.#connect("broker", address, options);
  }
  static async connectMachineBroker(machine: string, options: SystemdConnectOptions): Promise<SystemdBus> {
    return await this.#connect("machine", machine, options);
  }
  static async connectPrivatePeer(address: string, options: SystemdConnectOptions): Promise<AuthenticatedSystemdBus> {
    return await this.#connect("private", address, options) as AuthenticatedSystemdBus;
  }

  getProperty<Signature extends SystemdSignature>(target: SystemdTarget, signature: Signature, options: SystemdCallOptions): Promise<SystemdValueFor<Signature>>;
  async getProperty(target: SystemdTarget, signature: SystemdSignature, options: SystemdCallOptions): Promise<SystemdValue> {
    const budget = validateOptions(options); validateTarget(target);
    if (!signatures.has(signature)) invalid("unsupported property signature");
    if (this.#closing) throw new ProcSafeError("operation-failed", "systemd connection is closed");
    try { return await this.#native.getProperty(target.destination, target.path, target.interface, target.member, signature, options.timeoutMs, budget); }
    catch (error) { throw fromNativeError(error); }
  }

  async call(target: SystemdTarget, args: readonly SystemdArg[], options: SystemdCallOptions): Promise<SystemdValue> {
    const budget = validateOptions(options); validateTarget(target);
    if (!Array.isArray(args)) invalid("args must be an array");
    const encoded = args.map(arg => {
      if (!arg) invalid("invalid systemd argument");
      switch (arg.type) {
        case "s": case "o":
          if (typeof arg.value !== "string" || arg.value.includes("\0")) invalid("string argument must be NUL-free");
          break;
        case "u": case "i":
          if (!Number.isInteger(arg.value) || arg.value < (arg.type === "u" ? 0 : -0x80000000) || arg.value > (arg.type === "u" ? 0xffffffff : 0x7fffffff)) invalid("integer argument is outside its wire range");
          break;
        case "t":
          if (typeof arg.value !== "bigint" || arg.value < 0n || arg.value > 0xffffffffffffffffn) invalid("t argument must be an unsigned 64-bit bigint");
          break;
        case "b": if (typeof arg.value !== "boolean") invalid("b argument must be boolean"); break;
        default: invalid("unsupported argument type");
      }
      return { type: arg.type, value: String(arg.value) };
    });
    if (this.#closing) throw new ProcSafeError("operation-failed", "systemd connection is closed");
    try { return await this.#native.call(target.destination, target.path, target.interface, target.member, encoded, options.timeoutMs, budget); }
    catch (error) { throw fromNativeError(error); }
  }

  close(): Promise<void> {
    if (!this.#closing) {
      try { this.#closing = this.#native.close().catch(error => { throw fromNativeError(error); }); }
      catch (error) { this.#closing = Promise.reject(fromNativeError(error)); }
    }
    return this.#closing;
  }
  [Symbol.asyncDispose](): Promise<void> { return this.close(); }
}

export function isSupported(): boolean {
  try {
    if (process.platform !== "linux") return false;
    const native = getNativeBinding();
    return typeof native?.connectSystemd === "function" && native.systemdSupported?.() === true;
  }
  catch { return false; }
}
