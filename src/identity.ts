import { ProcSafeError } from "./errors.js";
import { fromNativeError } from "./native-error.js";
import { getNativeBinding, validatePid } from "./native.js";
import { walkProcessAncestry } from "./identity-ancestry.js";

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

export type ProcessAncestry = {
  readonly chain: readonly ProcessIdentity[];
  readonly complete: boolean;
  readonly stoppedBy: "root" | "missing-parent" | "recycled-parent" | "cycle" | "max-depth" | "through-pid" | "unreadable-parent";
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

/** Self first; unknown parents end a partial chain, but an unknown starting identity throws. */
export function readProcessAncestry(pid: number, options?: { maxDepth?: number; throughPid?: number }): ProcessAncestry | null {
  validatePid(pid);
  const maxDepth = options?.maxDepth ?? 32;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new ProcSafeError("invalid-argument", "maxDepth must be a positive safe integer");
  }
  if (options?.throughPid !== undefined) validatePid(options.throughPid);
  const self = readProcessIdentity(pid);
  return self === null ? null : walkProcessAncestry(self, maxDepth, options?.throughPid, readProcessIdentity);
}

export function isSupported(): boolean {
  try { return platformSupported() && typeof getNativeBinding()?.readProcessIdentity === "function"; }
  catch { return false; }
}
