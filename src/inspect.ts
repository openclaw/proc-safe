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

export type ProcessState = "running" | "sleeping" | "stopped" | "zombie" | "idle" | "unknown";

export type ProcessSnapshot = {
  readonly pid: number;
  readonly parentPid?: number;
  readonly identity?: ProcessIdentity;
  readonly owner: "same" | "different" | "unknown";
  readonly command?: ProcessCommand;
  readonly processGroupId?: number;
  readonly state?: ProcessState;
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

/** Complete Darwin or Windows PID census; unreadable facts remain explicitly unknown. */
export function listProcesses(options: { timeoutMs: number; includeCommand?: boolean; pids?: readonly number[] }): ProcessSnapshot[] {
  const start = performance.now();
  const timeoutMs = options?.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0
    || (options.includeCommand !== undefined && typeof options.includeCommand !== "boolean")) {
    throw new ProcSafeError("invalid-argument", "timeoutMs must be positive and finite; includeCommand must be boolean");
  }
  if (options.pids !== undefined) {
    if (!Array.isArray(options.pids)) throw new ProcSafeError("invalid-argument", "pids must be an array of platform PIDs");
    for (const pid of options.pids) validatePid(pid);
  }
  if (!platformSupported()) {
    throw new ProcSafeError("unsupported-platform", "process census requires Darwin or Windows");
  }
  const query = getNativeBinding()?.listProcesses;
  if (!query) throw new ProcSafeError("helper-unavailable", "native process census is unavailable");
  try {
    const rows = query(timeoutMs, options.includeCommand ?? false, options.pids === undefined ? undefined : [...new Set(options.pids)]).map(row => Object.freeze({
      pid: row.pid,
      owner: row.owner,
      ...(row.parentPid === undefined ? {} : { parentPid: row.parentPid }),
      ...(row.processGroupId === undefined ? {} : { processGroupId: row.processGroupId }),
      ...(row.state === undefined ? {} : { state: row.state }),
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
      && typeof binding.listProcesses === "function"
      && binding.inspectSupported?.() === true;
  } catch { return false; }
}
