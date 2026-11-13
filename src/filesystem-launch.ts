import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { ProcSafeError } from "./errors.js";
import { getNativeDiagnostic, getNativeModeSetting } from "./native.js";

const require = createRequire(import.meta.url);

export interface FilesystemRestrictedLaunchOptions {
  executable: string;
  args?: readonly string[];
  cwd?: string;
  /** Applied only to the target after the filesystem restriction is active. */
  env?: Readonly<Record<string, string>>;
  /** Existing files or directory trees that may be read and executed. */
  readOnlyPaths: readonly string[];
  /** Existing files or directory trees that may also be modified. */
  readWritePaths: readonly string[];
}

/** Prepare an exec wrapper for the caller's existing process owner.
 * This does not spawn or restrict the current process. The wrapper fails before
 * target execution if the kernel cannot enforce the complete filesystem policy.
 * Inherited descriptors remain capabilities; callers must select them explicitly.
 */
export function prepareFilesystemRestrictedLaunch(options: FilesystemRestrictedLaunchOptions): {
  command: string;
  args: string[];
} {
  if (process.platform !== "linux") {
    throw new ProcSafeError("unsupported-platform", "filesystem-restricted launch requires Linux");
  }
  if (getNativeModeSetting().mode === "off") {
    throw new ProcSafeError("helper-unavailable", "native proc-safe helpers are disabled");
  }
  const args: string[] = [];
  const addPath = (flag: string, value: string) => {
    if (!isAbsolute(value) || value.includes("\0")) {
      throw new ProcSafeError("invalid-argument", "filesystem launch paths must be absolute and contain no NUL");
    }
    args.push(flag, value);
  };
  for (const path of options.readOnlyPaths) addPath("--read-only", path);
  for (const path of options.readWritePaths) addPath("--read-write", path);
  if (options.cwd !== undefined) addPath("--cwd", options.cwd);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!key || key.includes("=") || key.includes("\0") || value.includes("\0")) {
      throw new ProcSafeError("invalid-argument", "filesystem launch environment must contain valid names and no NUL");
    }
    args.push("--env", `${key}=${value}`);
  }
  addPath("--", options.executable);
  for (const value of options.args ?? []) {
    if (value.includes("\0")) throw new ProcSafeError("invalid-argument", "filesystem launch arguments must contain no NUL");
    args.push(value);
  }
  const { packageName } = getNativeDiagnostic();
  if (!packageName) throw new ProcSafeError("unsupported-platform", "no filesystem launcher for this target");
  try {
    return { command: require.resolve(`${packageName}/proc-safe-filesystem-launch`), args };
  } catch (cause) {
    throw new ProcSafeError("helper-unavailable", "native filesystem launcher is unavailable", { cause });
  }
}
