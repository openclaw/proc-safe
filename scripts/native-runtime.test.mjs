import { test } from "node:test";

// Portable suite for hosts whose package manager or test-transformer has no native binary.
// This imports the same real-kernel proof executed by the Vitest and Bun lanes.
test("native identity, lifecycle, ancestry, coalition, and Worker boundaries", async () => {
  await import("./runtime-proof.mjs");
});

test("native diagnostics and test fixture boundaries", async () => {
  await import("./p2-proof.mjs");
});

test("native command inspection and Worker boundaries", async () => {
  const { proveInspection } = await import("./inspect-proof.mjs");
  await proveInspection();
});

test("native status on main and Worker", async () => {
  await import("./native-status-proof.mjs");
});

test("Windows token support and Worker boundaries", async () => {
  await import("./windows-token-proof.mjs");
});
