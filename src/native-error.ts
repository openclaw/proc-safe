import { ProcSafeError, type ProcSafeErrorCode } from "./errors.js";

const nativeCodes = new Set<ProcSafeErrorCode>([
  "unsupported-platform", "helper-unavailable", "access-denied", "layout-mismatch",
  "timeout", "incomplete", "invalid-argument", "operation-failed",
]);

/** Internal native errors carry a closed code before the first colon. */
export function fromNativeError(error: unknown): ProcSafeError {
  if (error instanceof ProcSafeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = message.slice(0, message.indexOf(":")) as ProcSafeErrorCode;
  const dbusErrorName = /^[^:]+: dbus-error\[([A-Za-z0-9_.]+)\]$/.exec(message)?.[1];
  const peerUidMismatch = /^access-denied: peer-uid-mismatch\[(\d+),(\d+)\]$/.exec(message);
  return new ProcSafeError(nativeCodes.has(code) ? code : "operation-failed", message, { cause: error,
    ...(dbusErrorName ? { details: { dbusErrorName } } : {}),
    ...(peerUidMismatch ? { details: { reason: "peer-uid-mismatch", expectedUid: Number(peerUidMismatch[1]), actualUid: Number(peerUidMismatch[2]) } } : {}),
    ...(code === "access-denied" && message === "access-denied: visibility-policy"
      ? { details: { reason: "visibility-policy" } } : {}),
    ...(code === "operation-failed" && message === "operation-failed: not-a-child"
      ? { details: { reason: "not-a-child" } } : {}),
  });
}
