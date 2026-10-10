import { ProcSafeError } from "./errors.js";
import { fromNativeError } from "./native-error.js";
import { getNativeBinding } from "./native.js";

function requirePlatform(platform: NodeJS.Platform): void {
  if (process.platform !== platform) throw new ProcSafeError("unsupported-platform", `test fixture requires ${platform}`);
}

/** Irreversible calling-thread filter. Only use inside a disposable fixture process. */
export function installKillGroupSeccompFilter(): void {
  requirePlatform("linux");
  const install = getNativeBinding()?.installKillGroupSeccompFilter;
  if (!install) throw new ProcSafeError("helper-unavailable", "native seccomp fixture is unavailable");
  try { install(); }
  catch (error) { throw fromNativeError(error); }
}

/** Windows test fixture: no inherited handles, console window, or libuv child ownership. */
export function spawnDetachedRaw(options: {
  executable: string;
  args?: readonly string[];
  cwd?: string;
}): { readonly pid: number } {
  const validString = (value: unknown): value is string => typeof value === "string" && !value.includes("\0");
  if (!options || !validString(options.executable) || !options.executable ||
    (options.args !== undefined && (!Array.isArray(options.args) || !options.args.every(validString))) ||
    (options.cwd !== undefined && (!validString(options.cwd) || !options.cwd))) {
    throw new ProcSafeError("invalid-argument", "fixture executable, arguments, and cwd must be strings without NULs");
  }
  requirePlatform("win32");
  const spawn = getNativeBinding()?.spawnDetachedRaw;
  if (!spawn) throw new ProcSafeError("helper-unavailable", "native detached-spawn fixture is unavailable");
  try { return Object.freeze({ pid: spawn(options.executable, [...options.args ?? []], options.cwd) }); }
  catch (error) { throw fromNativeError(error); }
}

export function hasConsoleWindow(): boolean {
  requirePlatform("win32");
  const query = getNativeBinding()?.hasConsoleWindow;
  if (!query) throw new ProcSafeError("helper-unavailable", "native console fixture is unavailable");
  try { return query(); }
  catch (error) { throw fromNativeError(error); }
}

export function isSupported(): boolean {
  try {
    const binding = (process.platform === "linux" || process.platform === "win32") ? getNativeBinding() : undefined;
    return process.platform === "linux" ? typeof binding?.installKillGroupSeccompFilter === "function"
      : process.platform === "win32" && typeof binding?.spawnDetachedRaw === "function" && typeof binding.hasConsoleWindow === "function";
  } catch { return false; }
}
