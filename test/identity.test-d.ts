import { readProcessAncestry, type ProcessAncestry, type ProcessIdentity } from "../src/identity.js";

const result: ProcessAncestry | null = readProcessAncestry(42, { maxDepth: 32, throughPid: 2 });
if (result) {
  const chain: readonly ProcessIdentity[] = result.chain;
  const reason: "root" | "missing-parent" | "recycled-parent" | "cycle" | "max-depth" | "through-pid" | "unreadable-parent" = result.stoppedBy;
  void chain;
  void reason;
  // @ts-expect-error ancestry metadata is readonly
  result.complete = true;
  // @ts-expect-error the chain is readonly
  result.chain.push(result.chain[0]!);
}
// @ts-expect-error the old array return contract is intentionally removed
const old: ProcessIdentity[] = readProcessAncestry(42);
void old;
