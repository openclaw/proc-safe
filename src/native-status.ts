import { getNativeBinding, getNativeDiagnostic, getNativeModeSetting } from "./native.js";

export type ProcSafeNativeMode = "auto" | "off" | "require";
export type ProcSafeNativeStatusReason =
  | "not-probed" | "loaded" | "disabled" | "unsupported-target"
  | "package-missing" | "load-failed" | "capability-missing";

export type ProcSafeNativeStatus = {
  mode: ProcSafeNativeMode;
  modeSource: "PROC_SAFE_NATIVE" | "default";
  reason: ProcSafeNativeStatusReason;
  loaded: boolean;
  target: string;
  packageName?: string;
  packageVersion?: string;
  loadErrorCode?: string;
  guidance?: string;
};

function nativeGuidance(reason: ProcSafeNativeStatusReason): string | undefined {
  switch (reason) {
    case "disabled":
      return "If native loading is intended, set PROC_SAFE_NATIVE=auto or PROC_SAFE_NATIVE=require; keep intentional off settings.";
    case "unsupported-target":
      return "Native process capabilities are unavailable on this target.";
    case "package-missing":
      return "Reinstall with optional dependencies included: npm --include=optional, or pnpm without --no-optional / optional=false. Check the lockfile and registry mirror.";
    case "load-failed":
      return "Check Node architecture, Linux libc compatibility, package dependencies, and OS code-integrity policy. Reinstalling identical bytes may not help.";
    case "capability-missing":
      return "Use matching proc-safe and platform-package versions; some targets intentionally provide only a subset of capabilities.";
    default:
      return undefined;
  }
}

export function readProcSafeNativeStatus(options?: { probe?: boolean }): ProcSafeNativeStatus {
  const { mode, source: modeSource } = getNativeModeSetting();
  if (options?.probe && mode !== "off") {
    try { getNativeBinding(); }
    catch { /* Required-mode load failures are cached and reported below. */ }
  }
  const diagnostic = getNativeDiagnostic();
  const guidance = nativeGuidance(diagnostic.reason);
  return {
    mode,
    modeSource,
    reason: diagnostic.reason,
    loaded: diagnostic.reason === "loaded",
    target: diagnostic.target,
    ...(diagnostic.packageName === undefined ? {} : {
      packageName: diagnostic.packageName,
      packageVersion: diagnostic.packageVersion,
    }),
    ...(diagnostic.reason === "load-failed" ? { loadErrorCode: diagnostic.code } : {}),
    ...(guidance === undefined ? {} : { guidance }),
  };
}
