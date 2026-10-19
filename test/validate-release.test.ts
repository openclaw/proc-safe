import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

function gitIn(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", ...args],
    { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Release Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Release Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
}

let template: string;
beforeAll(() => {
  template = mkdtempSync(join(tmpdir(), "proc-safe-release-template-"));
  mkdirSync(join(template, "scripts"));
  mkdirSync(join(template, "native"));
  writeFileSync(join(template, "package.json"), JSON.stringify({ type: "module", version: "1.2.3" }));
  writeFileSync(join(template, "native/package.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(join(template, "native/Cargo.toml"), '[package]\nversion = "1.2.3"\n');
  copyFileSync(new URL("../scripts/validate-release.mjs", import.meta.url), join(template, "scripts/validate-release.mjs"));
  writeFileSync(join(template, "scripts/native-targets.mjs"), "export const nativeTargets = []; export const nativePackageDirectory = () => {};\n");
  writeFileSync(join(template, "scripts/release-notes.mjs"), "// Notes validation is independent of source admission.\n");
  gitIn(template, "init", "-b", "main");
  gitIn(template, "add", ".");
  gitIn(template, "commit", "-m", "fixture");
  gitIn(template, "update-ref", "refs/remotes/origin/main", "HEAD");
});
afterAll(() => rmSync(template, { recursive: true, force: true }));

function fixture(check: (cwd: string, git: (...args: string[]) => void) => void) {
  const cwd = mkdtempSync(join(tmpdir(), "proc-safe-release-"));
  try {
    cpSync(template, cwd, { recursive: true });
    const git = (...args: string[]) => gitIn(cwd, ...args);
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

test("release dry run admits current main without creating a tag", () => fixture(cwd => {
  expect(validate(cwd).status).toBe(0);
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
