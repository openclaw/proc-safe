import { ProcSafeError } from "./errors.js";
import { fromNativeError } from "./native-error.js";
import { getNativeBinding, validatePid } from "./native.js";

export type ChildWaitState =
  | { readonly kind: "none" }
  | { readonly kind: "running" }
  | { readonly kind: "exited"; readonly pid: number };

export type ChildExit = {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
};

function binding() {
  if (process.platform !== "linux") throw new ProcSafeError("unsupported-platform", "child reaping requires Linux");
  const native = getNativeBinding();
  if (!native?.becomeChildSubreaper || !native.isChildSubreaper || !native.inspectChildWaitState || !native.reapChild) {
    throw new ProcSafeError("helper-unavailable", "native child reaping is unavailable");
  }
  return native as Required<Pick<typeof native,
    "becomeChildSubreaper" | "isChildSubreaper" | "inspectChildWaitState" | "reapChild">>;
}

/** Process-wide adoption setting. Coordinate all child owners before enabling it. */
export function becomeChildSubreaper(): void {
  try { binding().becomeChildSubreaper(); }
  catch (error) { throw fromNativeError(error); }
}

export function isChildSubreaper(): boolean {
  try { return binding().isChildSubreaper(); }
  catch (error) { throw fromNativeError(error); }
}

/** Non-consuming wait observation. Omitting pid observes all our children. */
export function inspectChildWaitState(pid?: number): ChildWaitState {
  if (pid !== undefined) validatePid(pid);
  try {
    const result = binding().inspectChildWaitState(pid);
    return result.kind === "exited"
      ? Object.freeze({ kind: "exited", pid: result.pid }) : Object.freeze({ kind: result.kind });
  } catch (error) { throw fromNativeError(error); }
}

/** Reap only a caller-selected child; never pass a libuv-owned child here. */
export function reapChild(pid: number): ChildExit | null {
  validatePid(pid);
  try {
    const result = binding().reapChild(pid);
    return result === null ? null : Object.freeze({
      pid: result.pid, exitCode: result.exitCode ?? null, signal: result.signal ?? null,
    });
  } catch (error) { throw fromNativeError(error); }
}

export function isSupported(): boolean {
  try { binding(); return true; }
  catch { return false; }
}
