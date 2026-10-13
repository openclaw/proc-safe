import { ProcSafeError } from "./errors.js";
import { fromNativeError } from "./native-error.js";
import { getNativeBinding } from "./native.js";

/** The current process's AppContainer SID, or null when its token proves it is not contained. */
export function readCurrentAppContainerSid(): string | null {
  if (process.platform !== "win32") {
    throw new ProcSafeError("unsupported-platform", "AppContainer token inspection requires Windows");
  }
  const read = getNativeBinding()?.readCurrentAppContainerSid;
  if (!read) throw new ProcSafeError("helper-unavailable", "native AppContainer token inspection is unavailable");
  try { return read(); }
  catch (error) { throw fromNativeError(error); }
}

export function isSupported(): boolean {
  try { return process.platform === "win32" && typeof getNativeBinding()?.readCurrentAppContainerSid === "function"; }
  catch { return false; }
}
