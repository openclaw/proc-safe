import assert from "node:assert/strict";

export const windowsRuntimeFlags = ["-Ctarget-feature=+crt-static", "-Clink-arg=/NODEFAULTLIB:libucrt.lib", "-Clink-arg=ucrt.lib"];

export function verifyWindowsRuntime(binary, cpu, { dll = true } = {}) {
  const check = (condition, message) => assert.ok(condition, `Invalid Windows binary: ${message}`);
  const range = (offset, size, limit = binary.length) => {
    check(Number.isSafeInteger(offset) && offset >= 0 && size >= 0 && offset + size <= limit, "truncated PE data");
  };
  range(0, 64);
  check(binary.readUInt16LE(0) === 0x5a4d, "missing DOS signature");
  const pe = binary.readUInt32LE(60);
  range(pe, 24);
  check(pe >= 64 && binary.readUInt32LE(pe) === 0x4550, "missing PE signature");
  const machine = binary.readUInt16LE(pe + 4);
  check((cpu === "x86" && machine === 0x14c) || (cpu === "x64" && machine === 0x8664) || (cpu === "arm64" && machine === 0xaa64), `wrong machine for ${cpu}`);
  check(((binary.readUInt16LE(pe + 22) & 0x2000) !== 0) === dll, dll ? "expected a DLL" : "expected an executable");
  const optional = pe + 24;
  const optionalSize = binary.readUInt16LE(pe + 20);
  range(optional, optionalSize);
  const directoryOffset = cpu === "x86" ? 96 : 112;
  check(optionalSize >= directoryOffset && binary.readUInt16LE(optional) === (cpu === "x86" ? 0x10b : 0x20b), cpu === "x86" ? "expected PE32" : "expected PE32+");
  const imageSize = binary.readUInt32LE(optional + 56);
  const headerSize = binary.readUInt32LE(optional + 60);
  const directories = binary.readUInt32LE(optional + directoryOffset - 4);
  check(directories <= 16 && directoryOffset + directories * 8 <= optionalSize, "invalid data directories");
  const sectionCount = binary.readUInt16LE(pe + 6);
  const sectionTable = optional + optionalSize;
  check(sectionCount > 0 && sectionTable + sectionCount * 40 <= headerSize, "invalid section table");
  range(0, headerSize);
  const sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const entry = sectionTable + index * 40;
    const rva = binary.readUInt32LE(entry + 12);
    const size = binary.readUInt32LE(entry + 16);
    const offset = binary.readUInt32LE(entry + 20);
    range(offset, size);
    check(rva + size <= imageSize, "section outside image");
    if (size) sections.push({ rva, size, offset });
  }
  const span = (rva, size) => {
    check(rva > 0 && rva + size <= imageSize, "RVA outside image");
    if (rva < headerSize) {
      range(rva, size, headerSize);
      return { offset: rva, available: headerSize - rva };
    }
    const matches = sections.filter(section => rva >= section.rva && rva - section.rva < section.size);
    check(matches.length === 1, "unmapped or ambiguous RVA");
    const section = matches[0];
    const available = section.size - (rva - section.rva);
    check(size <= available, "RVA exceeds section data");
    return { offset: section.offset + rva - section.rva, available };
  };
  const dllName = rva => {
    const { offset, available } = span(rva, 1);
    const end = binary.indexOf(0, offset);
    check(end > offset && end < offset + available, "unterminated DLL name");
    const bytes = binary.subarray(offset, end);
    check(bytes.every(byte => byte >= 0x21 && byte <= 0x7e), "invalid DLL name");
    const name = bytes.toString("ascii").toLowerCase();
    check(!/[\\/:]/.test(name) && name.endsWith(".dll"), "invalid DLL name");
    return name;
  };
  const imports = (directory, stride, nameOffset, delay = false) => {
    if (directory >= directories) return [];
    const entry = optional + directoryOffset + directory * 8;
    const rva = binary.readUInt32LE(entry);
    const size = binary.readUInt32LE(entry + 4);
    if (rva === 0 && size === 0) return [];
    check(rva !== 0 && size >= stride, "invalid import directory");
    const { offset } = span(rva, size);
    const names = [];
    for (let current = offset; current + stride <= offset + size; current += stride) {
      if (binary.subarray(current, current + stride).every(byte => byte === 0)) return names;
      // Require RVA-based delay descriptors, not legacy virtual addresses.
      if (delay) check(binary.readUInt32LE(current) === 1, "invalid delay-import attributes");
      names.push(dllName(binary.readUInt32LE(current + nameOffset)));
    }
    check(false, "unterminated import directory");
  };
  const direct = imports(1, 20, 12);
  const delayed = imports(13, 32, 4, true);
  const dependencies = [...new Set([...direct, ...delayed])].sort();
  const external = dependencies.filter(name => /^(?:vcruntime|msvcp|msvcr|concrt|vcomp|vccorlib)\d.*\.dll$|^ucrtbased\.dll$/.test(name));
  assert.equal(external.length, 0, `Windows addon requires a VC redistributable: ${external.join(", ")}`);
  assert.ok(dependencies.some(name => name === "ucrtbase.dll" || /^api-ms-win-crt-[\w-]+\.dll$/.test(name)),
    "Windows addon must use the OS-provided UCRT");
  return { cpu, imports: [...new Set(direct)].sort(), delayImports: [...new Set(delayed)].sort() };
}
