import { ProcSafeError } from "./errors.js";
import { fromNativeError } from "./native-error.js";
import { getNativeBinding } from "./native.js";

export type PageCacheResidency = {
  readonly pageSize: number;
  readonly sampledPages: number;
  readonly residentPages: number;
};

/** Sample evenly spaced file pages without faulting their contents into memory. */
export function samplePageCacheResidency(fd: number, options: { maxPages: number }): PageCacheResidency {
  if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fffffff) {
    throw new ProcSafeError("invalid-argument", "fd must be a nonnegative file descriptor");
  }
  if (!Number.isSafeInteger(options?.maxPages) || options.maxPages < 1) {
    throw new ProcSafeError("invalid-argument", "maxPages must be a positive safe integer");
  }
  if (process.platform !== "linux") throw new ProcSafeError("unsupported-platform", "page-cache sampling requires Linux");
  const sample = getNativeBinding()?.samplePageCacheResidency;
  if (!sample) throw new ProcSafeError("helper-unavailable", "native page-cache sampling is unavailable");
  try { return Object.freeze(sample(fd, options.maxPages)); }
  catch (error) { throw fromNativeError(error); }
}

export function isSupported(): boolean {
  try { return process.platform === "linux" && typeof getNativeBinding()?.samplePageCacheResidency === "function"; }
  catch { return false; }
}
