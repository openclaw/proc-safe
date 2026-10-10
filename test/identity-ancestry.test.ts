import { expect, test } from "vitest";
import { proveAncestryTransitions } from "../scripts/ancestry-transitions.mjs";

test("ancestry traversal preserves stop reasons, birth ordering, and read boundaries", () => {
  expect(proveAncestryTransitions()).toBe(25);
});
