import { ProcSafeError } from "./errors.js";
import { fromNativeError } from "./native-error.js";
import { getNativeBinding, validatePid } from "./native.js";

export type DarwinCoalition = { readonly id: bigint; readonly name?: string };

/** Resource coalition; the optional name is resolved through private libxpc symbols. */
export function readProcessCoalition(pid: number): DarwinCoalition | null {
  validatePid(pid);
  if (process.platform !== "darwin" || !["x64", "arm64"].includes(process.arch)) {
    throw new ProcSafeError("unsupported-platform", "process coalitions require Darwin");
  }
  const query = getNativeBinding()?.readProcessCoalition;
  if (!query) throw new ProcSafeError("helper-unavailable", "native coalition inspection is unavailable");
  try {
    const result = query(pid);
    return result === null ? null : Object.freeze(result);
  } catch (error) { throw fromNativeError(error); }
}

export function isSupported(): boolean {
  try { return process.platform === "darwin" && typeof getNativeBinding()?.readProcessCoalition === "function"; }
  catch { return false; }
}
