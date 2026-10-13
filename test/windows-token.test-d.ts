import { isSupported, readCurrentAppContainerSid } from "../src/windows-token.js";
const supported: boolean = isSupported();
const sid: string | null = readCurrentAppContainerSid();
void supported;
void sid;
// @ts-expect-error the current process token reader accepts no PID
readCurrentAppContainerSid(42);
