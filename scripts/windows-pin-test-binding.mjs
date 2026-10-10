import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Test harness only: production loading has no override or fault configuration.
export function installPinTestBinding() {
  if (!process.env.PROC_SAFE_TEST_JOB_FAULT_ADDON) return {};
  const require = createRequire(import.meta.url);
  const nativePath = require.resolve(`@openclaw/proc-safe-win32-${process.arch}-msvc`);
  const injected = require(process.env.PROC_SAFE_TEST_JOB_FAULT_ADDON);
  assert.equal(typeof injected.failNextWindowsJobAssignment, "function");
  assert.equal(typeof injected.inspectWindowsPinAccess, "function");
  let lastNativePin;
  require.cache[nativePath] = { id: nativePath, filename: nativePath, loaded: true, exports: {
    ...injected,
    openPinnedProcess(...args) { return lastNativePin = injected.openPinnedProcess(...args); },
  } };
  return {
    injectAssignmentFailure: injected.failNextWindowsJobAssignment,
    inspectPinAccess: () => injected.inspectWindowsPinAccess(lastNativePin),
  };
}
