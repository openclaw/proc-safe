import { ProcSafeError } from "./errors.js";
import type { ProcessIdentity } from "./identity.js";
import type { NativeJob, NativeJobChild, NativePinnedProcess } from "./native-binding.js";
import { fromNativeError } from "./native-error.js";
import { getNativeBinding, validatePid } from "./native.js";

export type WindowsJobSpawnOptions = {
  readonly executable: string;
  readonly commandLine: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
};

const key = Symbol();
const jobs = new WeakMap<WindowsJob, NativeJob>();
const children = new WeakMap<WindowsJobChild, NativeJobChild>();
const pinned = new WeakMap<PinnedProcess, NativePinnedProcess>();
let createChild: (native: NativeJobChild) => WindowsJobChild;
function call<T>(fn: () => T): T {
  try { return fn(); } catch (error) { throw fromNativeError(error); }
}
function binding() {
  if (process.platform !== "win32" || !["arm64", "x64"].includes(process.arch)) {
    throw new ProcSafeError("unsupported-platform", "Windows jobs require Windows x64 or arm64");
  }
  const native = getNativeBinding();
  if (!native?.createWindowsJob || !native.openWindowsJob || !native.openPinnedProcess || !native.isCurrentProcessInJob) {
    throw new ProcSafeError("helper-unavailable", "native Windows jobs are unavailable");
  }
  return native as Required<Pick<typeof native, "createWindowsJob" | "openWindowsJob" | "openPinnedProcess" | "isCurrentProcessInJob">>;
}
function nativeOwner<T extends object, N>(map: WeakMap<T, N>, value: T): N {
  const native = map.get(value);
  if (!native) throw new ProcSafeError("invalid-argument", "resource is closed or is not an owned resource");
  return native;
}
function text(value: string, label: string, empty = false): string {
  if (typeof value !== "string" || (!empty && value.length === 0) || value.includes("\0")) {
    throw new ProcSafeError("invalid-argument", `${label} must be a ${empty ? "" : "nonempty "}string without NUL`);
  }
  return value;
}
function uint(value: number, label: string, min = 0): number {
  if (!Number.isInteger(value) || value < min || value > 0xffffffff) {
    throw new ProcSafeError("invalid-argument", `${label} must be an unsigned 32-bit integer${min ? " greater than zero" : ""}`);
  }
  return value;
}

export class WindowsJob implements Disposable {
  private constructor(native: NativeJob, token: symbol) {
    if (token !== key) throw new ProcSafeError("invalid-argument", "use WindowsJob.create or WindowsJob.open");
    jobs.set(this, native);
    Object.freeze(this);
  }
  static create(options?: { name?: string; killOnJobClose?: boolean }): WindowsJob {
    const native = binding();
    const name = options?.name === undefined ? undefined : text(options.name, "name");
    const kill = options?.killOnJobClose ?? true;
    if (typeof kill !== "boolean") throw new ProcSafeError("invalid-argument", "killOnJobClose must be boolean");
    return new WindowsJob(call(() => native.createWindowsJob(name, kill)), key);
  }
  static open(name: string): WindowsJob | null {
    const native = binding();
    text(name, "name");
    const resource = call(() => native.openWindowsJob(name));
    return resource === null ? null : new WindowsJob(resource, key);
  }
  assignCurrentProcess(): void { call(() => nativeOwner(jobs, this).assignCurrent()); }
  assignProcess(target: PinnedProcess): void { call(() => nativeOwner(jobs, this).assign(nativeOwner(pinned, target))); }
  spawn(options: WindowsJobSpawnOptions): WindowsJobChild {
    const job = nativeOwner(jobs, this);
    text(options.executable, "executable");
    text(options.commandLine, "commandLine");
    if (options.cwd !== undefined) text(options.cwd, "cwd");
    let environment: string[] | undefined;
    if (options.env !== undefined) {
      const seen = new Set<string>();
      environment = Object.entries(options.env).map(([name, value]) => {
        text(name, "environment name");
        text(value, "environment value", true);
        const folded = name.toUpperCase();
        if (name.includes("=") || seen.has(folded)) {
          throw new ProcSafeError("invalid-argument", "environment names must be unique ignoring case and contain no equals sign");
        }
        seen.add(folded);
        return `${name}=${value}`;
      }).sort((a, b) => a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0);
    }
    return createChild(call(() => job.spawn(options.executable, options.commandLine, options.cwd, environment)));
  }
  processIds(): number[] { return call(() => nativeOwner(jobs, this).processIds()); }
  accounting(): { readonly activeProcesses: number; readonly totalProcesses: number; readonly terminatedProcesses: number } {
    return Object.freeze(call(() => nativeOwner(jobs, this).accounting()));
  }
  terminate(exitCode: number): void { uint(exitCode, "exitCode"); call(() => nativeOwner(jobs, this).terminate(exitCode)); }
  close(): void {
    const resource = jobs.get(this);
    if (resource) { jobs.delete(this); call(() => resource.close()); }
  }
  [Symbol.dispose](): void { this.close(); }
}

export class WindowsJobChild implements Disposable {
  private constructor(native: NativeJobChild, token: symbol) {
    if (token !== key) throw new ProcSafeError("invalid-argument", "children are created by WindowsJob.spawn");
    children.set(this, native); Object.freeze(this);
  }
  static { createChild = native => new WindowsJobChild(native, key); }
  get pid(): number { return call(() => nativeOwner(children, this).pid); }
  readStdout(maxBytes: number): Buffer | null { uint(maxBytes, "maxBytes", 1); return call(() => nativeOwner(children, this).readStdout(maxBytes)); }
  readStderr(maxBytes: number): Buffer | null { uint(maxBytes, "maxBytes", 1); return call(() => nativeOwner(children, this).readStderr(maxBytes)); }
  exitCode(): number | null { return call(() => nativeOwner(children, this).exitCode()); }
  close(): void {
    const resource = children.get(this);
    if (resource) { children.delete(this); call(() => resource.close()); }
  }
  [Symbol.dispose](): void { this.close(); }
}

export class PinnedProcess implements Disposable {
  private constructor(native: NativePinnedProcess, token: symbol) {
    if (token !== key) throw new ProcSafeError("invalid-argument", "use PinnedProcess.open");
    pinned.set(this, native); Object.freeze(this);
  }
  static open(pid: number, options?: { expect?: { imagePath?: string; startTimeMicros?: number }; access?: "observe" | "lifetime-owner" | "job-member" }): PinnedProcess | null {
    const native = binding();
    validatePid(pid);
    const expect = options?.expect;
    const access = options?.access ?? "observe";
    if (access !== "observe" && access !== "lifetime-owner" && access !== "job-member") {
      throw new ProcSafeError("invalid-argument", "access must be observe, lifetime-owner, or job-member");
    }
    if (expect?.imagePath !== undefined) text(expect.imagePath, "imagePath");
    if (expect?.startTimeMicros !== undefined && (!Number.isSafeInteger(expect.startTimeMicros) || expect.startTimeMicros < 0)) {
      throw new ProcSafeError("invalid-argument", "startTimeMicros must be a nonnegative safe integer");
    }
    const resource = call(() => native.openPinnedProcess(pid, expect?.imagePath, expect?.startTimeMicros, access));
    return resource === null ? null : new PinnedProcess(resource, key);
  }
  get identity(): ProcessIdentity { return Object.freeze(call(() => nativeOwner(pinned, this).identity)); }
  get imagePath(): string { return call(() => nativeOwner(pinned, this).imagePath); }
  get access(): "observe" | "lifetime-owner" | "job-member" { return call(() => nativeOwner(pinned, this).access); }
  close(): void {
    const resource = pinned.get(this);
    if (resource) { pinned.delete(this); call(() => resource.close()); }
  }
  [Symbol.dispose](): void { this.close(); }
}

export function isCurrentProcessInJob(): boolean { return call(() => binding().isCurrentProcessInJob()); }
/** Assign the current process and consume the owner, retaining its handle until OS process exit. */
export function retainCurrentProcessJobUntilExit(job: WindowsJob): void {
  call(() => nativeOwner(jobs, job).retain());
  jobs.delete(job);
}
/** The verified owner receives the only handle to a fresh job containing this process. */
export function bindCurrentProcessLifetimeTo(owner: PinnedProcess): void {
  call(() => nativeOwner(pinned, owner).bindLifetime());
}
export function isSupported(): boolean { try { binding(); return true; } catch { return false; } }
