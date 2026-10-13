import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { isMissingNativePackage } from "../src/native-load-error.js";

const packageName = "@openclaw/proc-safe-missing-test-package";

test("recognizes Node and Bun missing-package resolver messages", () => {
  const require = createRequire(import.meta.url);
  let missing: unknown;
  try { require.resolve(packageName); }
  catch (error) { missing = error; }
  expect(isMissingNativePackage(missing, packageName)).toBe(true);
  expect(isMissingNativePackage(Object.assign(new Error(`Cannot find module '${packageName}' from '/private/fixture.js'`), {
    code: "MODULE_NOT_FOUND",
  }), packageName)).toBe(true);
});

test("does not mistake missing entry points or nested dependencies for missing packages", () => {
  for (const message of [
    "Cannot find module 'nested-dependency'",
    `Cannot find module '/node_modules/${packageName}/index.js'`,
    `Cannot find module '${packageName}/child' from '/private/fixture.js'`,
  ]) {
    expect(isMissingNativePackage(Object.assign(new Error(message), { code: "MODULE_NOT_FOUND" }), packageName)).toBe(false);
  }
});
