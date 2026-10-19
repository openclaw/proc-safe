import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

function fixture(check: (cwd: string, git: (...args: string[]) => void) => void) {
  const cwd = mkdtempSync(join(tmpdir(), "proc-safe-release-"));
  const git = (...args: string[]) => {
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", ...args],
      { cwd, stdio: "pipe" });
  };
  try {
    mkdirSync(join(cwd, "scripts"));
    mkdirSync(join(cwd, "native"));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ type: "module", version: "1.2.3" }));
    writeFileSync(join(cwd, "native/package.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(join(cwd, "native/Cargo.toml"), '[package]\nversion = "1.2.3"\n');
    copyFileSync(new URL("../scripts/validate-release.mjs", import.meta.url), join(cwd, "scripts/validate-release.mjs"));
    writeFileSync(join(cwd, "scripts/native-targets.mjs"), "export const nativeTargets = []; export const nativePackageDirectory = () => {};\n");
    writeFileSync(join(cwd, "scripts/release-notes.mjs"), "// Notes validation is independent of source admission.\n");
    git("init", "-b", "main");
    git("config", "user.name", "Release Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("add", ".");
    git("commit", "-m", "fixture");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    check(cwd, git);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function validate(cwd: string, overrides: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["scripts/validate-release.mjs"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, RELEASE_TAG: "v1.2.3", GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main", DRY_RUN: "true", ...overrides },
  });
}

test("release dry run admits current main without creating a tag", () => fixture((cwd, git) => {
  expect(validate(cwd).status).toBe(0);
  git("show-ref", "--verify", "refs/remotes/origin/main");
  expect(spawnSync("git", ["tag", "--list"], { cwd, encoding: "utf8" }).stdout).toBe("");
}));

test("manual dispatch cannot admit publication", () => fixture(cwd => {
  expect(validate(cwd, { DRY_RUN: "false" }).stderr).toContain("manual runs must be dry runs");
}));

test("release dry run rejects a non-main branch", () => fixture(cwd => {
  expect(validate(cwd, { GITHUB_REF: "refs/heads/candidate" }).stderr).toContain("dry runs must use main");
}));

test("release dry run rejects source that differs from latest main", () => fixture((cwd, git) => {
  writeFileSync(join(cwd, "changed"), "different source");
  git("add", ".");
  git("commit", "-m", "different source");
  expect(validate(cwd).stderr).toContain("release must point to latest main");
}));

test("release dry run still rejects mismatched package versions", () => fixture(cwd => {
  expect(validate(cwd, { RELEASE_TAG: "v1.2.4" }).status).not.toBe(0);
}));

test("tag publication still requires an annotated tag at latest main", () => fixture((cwd, git) => {
  git("tag", "-a", "v1.2.3", "-m", "release");
  expect(validate(cwd, { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v1.2.3", DRY_RUN: "false" }).status).toBe(0);
}));

test("tag publication rejects a lightweight tag", () => fixture((cwd, git) => {
  git("tag", "v1.2.3");
  expect(validate(cwd, { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v1.2.3", DRY_RUN: "false" }).status).not.toBe(0);
}));
