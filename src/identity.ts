import { ProcSafeError } from "./errors.js";
import { fromNativeError } from "./native-error.js";
import { getNativeBinding, validatePid } from "./native.js";

export type ProcessIdentity = {
  readonly pid: number;
  readonly parentPid: number;
  /** Epoch microseconds. Linux estimates against the current wall clock; see docs/identity.md. */
  readonly startTimeMicros: number;
  readonly startTimeResolutionMicros: number;
  /** Stable, tick-quantized birth on Linux; prefer this field for PID-reuse comparisons. */
  readonly startTimeSinceBootMicros?: number;
  readonly exited: boolean;
};

function platformSupported(): boolean {
  return ["darwin", "linux", "win32", "freebsd"].includes(process.platform)
    && ["x64", "arm64"].includes(process.arch);
}

/** null means no kernel object exists; retained exited objects still have an identity. */
export function readProcessIdentity(pid: number): ProcessIdentity | null {
  validatePid(pid);
  if (!platformSupported()) throw new ProcSafeError("unsupported-platform", "process identity is unsupported on this platform");
  const query = getNativeBinding()?.readProcessIdentity;
  if (!query) throw new ProcSafeError("helper-unavailable", "native process identity is unavailable");
  try {
    const result = query(pid);
    return result === null ? null : Object.freeze(result);
  } catch (error) { throw fromNativeError(error); }
}

/** Self first; exclude recycled parents and stop at PID 0/1, missing parents, or maxDepth. */
export function readProcessAncestry(pid: number, options?: { maxDepth?: number }): ProcessIdentity[] {
  validatePid(pid);
  const maxDepth = options?.maxDepth ?? 32;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new ProcSafeError("invalid-argument", "maxDepth must be a positive safe integer");
  }
  const ancestry: ProcessIdentity[] = [];
  const seen = new Set<number>();
  let next = pid;
  while (ancestry.length < maxDepth) {
    const current = readProcessIdentity(next);
    if (!current) break;
    const child = ancestry.at(-1);
    if (child) {
      const sinceBoot = current.startTimeSinceBootMicros !== undefined && child.startTimeSinceBootMicros !== undefined;
      const parentStart = sinceBoot ? current.startTimeSinceBootMicros! : current.startTimeMicros;
      const childStart = sinceBoot ? child.startTimeSinceBootMicros! : child.startTimeMicros;
      if (parentStart > childStart) break;
    }
    ancestry.push(current);
    seen.add(next);
    // Never read init/launchd as a parent: macOS denies proc_pidinfo on PID 1 to non-root callers.
    if (current.parentPid <= 1 || seen.has(current.parentPid)) break;
    next = current.parentPid;
  }
  return ancestry;
}

export function isSupported(): boolean {
  try { return platformSupported() && typeof getNativeBinding()?.readProcessIdentity === "function"; }
  catch { return false; }
}
