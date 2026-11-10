import { expect, test } from "vitest";
import { verifyWindowsRuntime } from "../scripts/windows-runtime.mjs";

function image(cpu: "x64" | "arm64", direct: string[], delayed: string[] = []) {
  const bytes = Buffer.alloc(4096);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128);
  bytes.writeUInt16LE(cpu === "x64" ? 0x8664 : 0xaa64, 132);
  bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(240, 148);
  bytes.writeUInt16LE(0x2000, 150);
  const optional = 152;
  bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt32LE(8192, optional + 56);
  bytes.writeUInt32LE(512, optional + 60);
  bytes.writeUInt32LE(16, optional + 108);
  bytes.writeUInt32LE(4096, 404);
  bytes.writeUInt32LE(3584, 408);
  bytes.writeUInt32LE(512, 412);
  let nameOffset = 2048;
  for (const [directory, tableOffset, stride, nameField, names] of [
    [1, 512, 20, 12, direct],
    [13, 1024, 32, 4, delayed],
  ] as const) {
    if (!names.length) continue;
    bytes.writeUInt32LE(tableOffset + 3584, optional + 112 + directory * 8);
    bytes.writeUInt32LE((names.length + 1) * stride, optional + 116 + directory * 8);
    for (const [index, name] of names.entries()) {
      const descriptor = tableOffset + index * stride;
      if (directory === 13) bytes.writeUInt32LE(1, descriptor);
      bytes.writeUInt32LE(nameOffset + 3584, descriptor + nameField);
      bytes.write(name, nameOffset, "ascii");
      nameOffset += name.length + 1;
    }
  }
  return bytes;
}

test.each(["x64", "arm64"] as const)("accepts OS UCRT imports on %s and rejects the other architecture", cpu => {
  const bytes = image(cpu, ["KERNEL32.dll", "api-ms-win-crt-runtime-l1-1-0.dll"], ["ucrtbase.dll"]);
  expect(verifyWindowsRuntime(bytes, cpu)).toEqual({
    cpu, imports: ["api-ms-win-crt-runtime-l1-1-0.dll", "kernel32.dll"], delayImports: ["ucrtbase.dll"],
  });
  expect(() => verifyWindowsRuntime(bytes, cpu === "x64" ? "arm64" : "x64")).toThrow("wrong machine");
});

test.each(["VCRUNTIME140.dll", "vcruntime140_1.dll", "MSVCP140_2.dll", "concrt140.dll", "vcomp140.dll", "msvcr120.dll", "ucrtbased.dll"])(
  "rejects redistributable dependency %s, including delay imports", name => {
    expect(() => verifyWindowsRuntime(image("x64", ["ucrtbase.dll", name]), "x64")).toThrow("VC redistributable");
    expect(() => verifyWindowsRuntime(image("arm64", ["ucrtbase.dll"], [name]), "arm64")).toThrow("VC redistributable");
  },
);

test("does not mistake an unrelated DLL name string for an imported dependency", () => {
  const bytes = image("x64", ["ucrtbase.dll"]);
  bytes.write("VCRUNTIME140.dll", 3000, "ascii");
  expect(verifyWindowsRuntime(bytes, "x64").imports).toEqual(["ucrtbase.dll"]);
  expect(() => verifyWindowsRuntime(image("x64", ["kernel32.dll"]), "x64")).toThrow("OS-provided UCRT");
});

test("rejects truncated headers and unmapped or unterminated import data", () => {
  const bytes = image("x64", ["ucrtbase.dll"]);
  expect(() => verifyWindowsRuntime(bytes.subarray(0, 200), "x64")).toThrow("truncated PE");
  bytes.writeUInt32LE(8000, 512 + 12);
  expect(() => verifyWindowsRuntime(bytes, "x64")).toThrow("unmapped");
  const missingTerminator = image("x64", ["ucrtbase.dll"]);
  missingTerminator.writeUInt32LE(20, 152 + 116 + 8);
  expect(() => verifyWindowsRuntime(missingTerminator, "x64")).toThrow("unterminated import directory");
  const missingName = image("x64", ["ucrtbase.dll"]);
  missingName.fill(65, 2048);
  expect(() => verifyWindowsRuntime(missingName, "x64")).toThrow("unterminated DLL name");
});
