import type { ProcessIdentity } from "./identity.js";
import type { DarwinCoalition } from "./darwin.js";
import type { PageCacheResidency } from "./diagnostics.js";
import type { ChildExit, ChildWaitState } from "./reaper.js";
import type { ProcessSnapshot } from "./inspect.js";
import type { SystemdValue } from "./systemd.js";

export interface NativeSystemdBus {
  readonly peerPid?: number;
  readonly peerUid?: number;
  getProperty(destination: string | undefined, path: string, iface: string, member: string, signature: string, timeoutMs: number, budget: number): Promise<SystemdValue>;
  call(destination: string | undefined, path: string, iface: string, member: string, args: { type: string; value: string }[], timeoutMs: number, budget: number): Promise<SystemdValue>;
  close(): Promise<void>;
}

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
  systemdSupported?(): boolean;
  connectSystemd?(mode: string, address: string, timeoutMs: number): Promise<NativeSystemdBus>;
  inspectSupported?(): boolean;
  readProcessCommand?(pid: number, environmentKeys: string[]): {
    executable: string;
    argv: string[];
    commandLine?: string;
    cwd?: string;
    environment: { key: string; value: string }[];
  } | null;
  listProcesses?(timeoutMs: number, includeCommand: boolean): {
    pid: number;
    owner: ProcessSnapshot["owner"];
    identity?: ProcessIdentity;
    command?: NonNullable<ReturnType<NonNullable<NativeBinding["readProcessCommand"]>>>;
  }[];
}
