import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { verifyWindowsRuntime, windowsRuntimeFlags } from "./windows-runtime.mjs";

const root = new URL("../", import.meta.url);
mkdirSync(new URL("target/", root), { recursive: true });
execFileSync("rustc", ["--target", "i686-pc-windows-msvc", "test/fixtures/inspect-child.rs",
  "-o", "target/inspect-child-x86.exe", ...windowsRuntimeFlags], { cwd: root, stdio: "inherit" });
console.log(JSON.stringify(verifyWindowsRuntime(readFileSync(new URL("target/inspect-child-x86.exe", root)), "x86", { dll: false })));
