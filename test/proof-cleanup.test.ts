import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
// @ts-expect-error Proof utilities are JavaScript, outside the package's declarations.
import { removeProofDirectory } from "../scripts/remove-proof-directory.mjs";

test.runIf(process.platform === "win32")("proof cleanup waits for a real Windows directory lock", async () => {
  const directory = mkdtempSync(join(tmpdir(), "proc-safe-cleanup-"));
  const child = spawn(process.execPath, ["-e", 'process.stdout.write("ready"); process.stdin.once("data", () => process.exit(0));'], {
    cwd: directory, stdio: ["pipe", "pipe", "inherit"],
  });
  const exited = once(child, "exit");
  let release: ReturnType<typeof setTimeout> | undefined;
  try {
    await once(child.stdout!, "data");
    let immediateError;
    try { rmSync(directory, { recursive: true, force: true }); }
    catch (error) { immediateError = error; }
    expect(immediateError).toMatchObject({ code: expect.stringMatching(/^(EBUSY|EPERM|ENOTEMPTY)$/) });
    release = setTimeout(() => child.stdin!.end("exit\n"), 250);
    await removeProofDirectory(directory);
    expect(await exited).toEqual([0, null]);
    expect(existsSync(directory)).toBe(false);
  } finally {
    clearTimeout(release);
    if (child.exitCode === null) child.kill();
    await exited;
    await removeProofDirectory(directory);
  }
}, 15_000);
