import type { ProcessIdentity } from "./identity.js";
import type { DarwinCoalition } from "./darwin.js";

export interface NativeBinding {
  readProcessIdentity?(pid: number): ProcessIdentity | null;
  readProcessCoalition?(pid: number): DarwinCoalition | null;
}
