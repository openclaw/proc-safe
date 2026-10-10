import { ProcSafeError } from "./errors.js";
import { fromNativeError } from "./native-error.js";
import { getNativeBinding, validatePid } from "./native.js";

export type ProcessCommand = {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly commandLine?: string;
  readonly cwd?: string;
  readonly environment: Readonly<Record<string, string>>;
};

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
    return Object.freeze({
      executable: result.executable,
      argv: Object.freeze(result.argv),
      ...(result.commandLine === undefined ? {} : { commandLine: result.commandLine }),
      ...(result.cwd === undefined ? {} : { cwd: result.cwd }),
      environment: Object.freeze(Object.fromEntries(result.environment.map(entry => [entry.key, entry.value]))),
    });
  } catch (error) { throw fromNativeError(error); }
}

export function isSupported(): boolean {
  try {
    if (!platformSupported()) return false;
    const binding = getNativeBinding();
    return typeof binding?.readProcessCommand === "function" && binding.inspectSupported?.() === true;
  } catch { return false; }
}
