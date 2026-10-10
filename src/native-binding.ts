import type { ProcessIdentity } from "./identity.js";
import type { DarwinCoalition } from "./darwin.js";
import type { PageCacheResidency } from "./diagnostics.js";

export interface NativeBinding {
  readProcessIdentity?(pid: number): ProcessIdentity | null;
  readProcessCoalition?(pid: number): DarwinCoalition | null;
  samplePageCacheResidency?(fd: number, maxPages: number): PageCacheResidency;
  installKillGroupSeccompFilter?(): void;
  spawnDetachedRaw?(executable: string, args: string[], cwd?: string): number;
  hasConsoleWindow?(): boolean;
}
