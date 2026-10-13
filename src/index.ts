export { ProcSafeError } from "./errors.js";
export type { ProcSafeErrorCode } from "./errors.js";
import type { ProcSafeNativeStatus } from "./native-status.js";
export type { ProcSafeNativeMode, ProcSafeNativeStatus, ProcSafeNativeStatusReason } from "./native-status.js";

/** Read cached native status; only an explicit probe attempts to load the addon. */
export async function getProcSafeNativeStatus(options?: { probe?: boolean }): Promise<ProcSafeNativeStatus> {
  const { readProcSafeNativeStatus } = await import("./native-status.js");
  return readProcSafeNativeStatus(options);
}
