import { PinnedProcess, WindowsJob, bindCurrentProcessLifetimeTo } from "../src/windows-job.js";

const observer = PinnedProcess.open(123);
const owner = PinnedProcess.open(123, { access: "lifetime-owner", expect: { startTimeMicros: 456 } });
const member = PinnedProcess.open(123, { access: "job-member", expect: { imagePath: "example.exe" } });
if (observer) {
  const access: "observe" | "lifetime-owner" | "job-member" = observer.access;
  void access;
  // @ts-expect-error access is readonly
  observer.access = "job-member";
}
if (owner) bindCurrentProcessLifetimeTo(owner);
if (member) WindowsJob.create().assignProcess(member);
// @ts-expect-error expectations must be nested inside options.expect
PinnedProcess.open(123, { imagePath: "example.exe" });
// @ts-expect-error only named capability modes are accepted
PinnedProcess.open(123, { access: "all" });


const job = WindowsJob.create();
const child = job.spawn({ executable: "example.exe", commandLine: "example.exe", stdin: "pipe" });
const accepted: number | null = child.writeStdin(Buffer.from("synthetic-input"));
void accepted;
child.closeStdin();
job.spawn({ executable: "example.exe", commandLine: "example.exe", stdin: "null" });
// @ts-expect-error no inherited stdin capability
job.spawn({ executable: "example.exe", commandLine: "example.exe", stdin: "inherit" });
// @ts-expect-error only Buffer input; empty Buffers are rejected at runtime
child.writeStdin("synthetic-input");
// @ts-expect-error raw Uint8Array is not the input contract
child.writeStdin(new Uint8Array([1]));
