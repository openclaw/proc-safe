export type ProcSafeErrorCode =
  | "unsupported-platform" | "helper-unavailable" | "access-denied"
  | "layout-mismatch" | "timeout" | "incomplete" | "invalid-argument" | "operation-failed";

export class ProcSafeError extends Error {
  readonly code: ProcSafeErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: ProcSafeErrorCode, message: string,
    options: { cause?: unknown; details?: Readonly<Record<string, unknown>> } = {}) {
    super(message, options);
    this.name = "ProcSafeError";
    this.code = code;
    this.details = options.details;
  }
}
