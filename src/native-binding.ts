import type { ProcessIdentity } from "./identity.js";
import type { DarwinCoalition } from "./darwin.js";
import type { PageCacheResidency } from "./diagnostics.js";
import type { ChildExit, ChildWaitState } from "./reaper.js";

export interface NativeBinding {
  readProcessIdentity?(pid: number): ProcessIdentity | null;
  readProcessCoalition?(pid: number): DarwinCoalition | null;
  samplePageCacheResidency?(fd: number, maxPages: number): PageCacheResidency;
  installKillGroupSeccompFilter?(): void;
  spawnRawWithoutConsole?(executable: string, args: string[], cwd?: string): number;
  hasConsoleWindow?(): boolean;
  becomeChildSubreaper?(): void;
  isChildSubreaper?(): boolean;
  inspectChildWaitState?(pid?: number): ChildWaitState;
  reapChild?(pid: number): ChildExit | null;
}
