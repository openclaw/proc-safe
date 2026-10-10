import { ProcSafeError } from "./errors.js";
import { fromNativeError } from "./native-error.js";
import { getNativeBinding, validatePid } from "./native.js";
import type { ProcessIdentity } from "./identity.js";
import type { NativeBinding } from "./native-binding.js";

export type ProcessCommand = {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly commandLine?: string;
  readonly cwd?: string;
  readonly environment: Readonly<Record<string, string>>;
};

export type ProcessSnapshot = {
  readonly pid: number;
  readonly identity?: ProcessIdentity;
  readonly owner: "same" | "different" | "unknown";
  readonly command?: ProcessCommand;
};

function commandResult(result: NonNullable<ReturnType<NonNullable<NativeBinding["readProcessCommand"]>>>): ProcessCommand {
  return Object.freeze({
    executable: result.executable,
    argv: Object.freeze(result.argv),
    ...(result.commandLine === undefined ? {} : { commandLine: result.commandLine }),
    ...(result.cwd === undefined ? {} : { cwd: result.cwd }),
    environment: Object.freeze(Object.fromEntries(result.environment.map(entry => [entry.key, entry.value]))),
  });
}

function platformSupported(): boolean {
  return ["darwin", "win32"].includes(process.platform) && ["x64", "arm64"].includes(process.arch);
}

/** Exact command observation; only explicitly named environment keys leave native code. */
export function readProcessCommand(pid: number, options?: { environmentKeys?: readonly string[] }): ProcessCommand | null {
  validatePid(pid);
  const keys = options?.environmentKeys ?? [];
  if (!Array.isArray(keys) || keys.some(key => typeof key !== "string" || !key || /[=\0]/.test(key))) {
    throw new ProcSafeError("invalid-argument", "environmentKeys must contain nonempty names without NUL or equals");
  }
  if (!platformSupported()) throw new ProcSafeError("unsupported-platform", "process command inspection requires Darwin or Windows");
  const query = getNativeBinding()?.readProcessCommand;
  if (!query) throw new ProcSafeError("helper-unavailable", "native process command inspection is unavailable");
  try {
    const result = query(pid, [...new Set(keys)]);
    if (result === null) return null;
    return commandResult(result);
  } catch (error) { throw fromNativeError(error); }
}

/** Complete Windows PID census; unavailable per-process facts remain explicitly unknown. */
export function listProcesses(options: { timeoutMs: number; includeCommand?: boolean }): ProcessSnapshot[] {
  const start = performance.now();
  const timeoutMs = options?.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0
    || (options.includeCommand !== undefined && typeof options.includeCommand !== "boolean")) {
    throw new ProcSafeError("invalid-argument", "timeoutMs must be positive and finite; includeCommand must be boolean");
  }
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) {
    throw new ProcSafeError("unsupported-platform", "process census requires Windows");
  }
  const query = getNativeBinding()?.listProcesses;
  if (!query) throw new ProcSafeError("helper-unavailable", "native process census is unavailable");
  try {
    const rows = query(timeoutMs, options.includeCommand ?? false).map(row => Object.freeze({
      pid: row.pid,
      owner: row.owner,
      ...(row.identity === undefined ? {} : { identity: Object.freeze(row.identity) }),
      ...(row.command === undefined ? {} : { command: commandResult(row.command) }),
    }));
    if (performance.now() - start >= timeoutMs) throw new ProcSafeError("timeout", "process census exceeded timeoutMs");
    return rows;
  } catch (error) { throw fromNativeError(error); }
}

export function isSupported(): boolean {
  try {
    if (!platformSupported()) return false;
    const binding = getNativeBinding();
    return typeof binding?.readProcessCommand === "function"
      && (process.platform !== "win32" || typeof binding.listProcesses === "function")
      && binding.inspectSupported?.() === true;
  } catch { return false; }
}
