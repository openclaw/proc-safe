import { getProcSafeNativeStatus, type ProcSafeNativeStatus, type ProcSafeNativeMode } from "../src/index.js";

const status: Promise<ProcSafeNativeStatus> = getProcSafeNativeStatus({ probe: true });
const mode: ProcSafeNativeMode = "require";
void status;
void mode;
// @ts-expect-error probing takes a boolean
getProcSafeNativeStatus({ probe: "true" });
// @ts-expect-error status is asynchronous
const synchronous: ProcSafeNativeStatus = getProcSafeNativeStatus();
void synchronous;
