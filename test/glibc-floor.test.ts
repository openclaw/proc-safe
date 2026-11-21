import { expect, test } from "vitest";
import { verifyGlibcFloor } from "../scripts/check-glibc-floor.mjs";

test("glibc floor admits historical symbol versions and the exact floor", () => {
  expect(verifyGlibcFloor("(GLIBC_2.2.5) open\n(GLIBC_2.17) clock_gettime\n(GLIBC_2.28) statx", "2.28"))
    .toEqual(["GLIBC_2.17", "GLIBC_2.2.5", "GLIBC_2.28"]);
});

test.each(["GLIBC_2.33", "GLIBC_2.34", "GLIBC_2.28.1", "GLIBC_3.0"])("rejects newer dependency %s", version => {
  expect(() => verifyGlibcFloor(`(GLIBC_2.17) open\n(${version}) pthread_create`, "2.28")).toThrow("exceeds");
});

test.each(["", "GLIBC_PRIVATE", "GLIBC_ABI_DT_RELR"])("rejects missing or unrecognized glibc versions: %s", symbols => {
  expect(() => verifyGlibcFloor(symbols, "2.28")).toThrow();
});
