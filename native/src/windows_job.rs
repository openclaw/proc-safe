use crate::{
    error::failure,
    identity::{ProcessIdentity, windows::read_handle},
};
use napi::{Result, bindgen_prelude::Buffer};
use napi_derive::napi;
use std::{
    ffi::c_void,
    mem::{size_of, zeroed},
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::SECURITY_ATTRIBUTES,
    Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING, ReadFile,
    },
    System::{
        JobObjects::*,
        Pipes::{CreatePipe, PeekNamedPipe},
        Threading::*,
    },
};

#[cfg(feature = "fault-injection")]
thread_local! {
    static FAIL_ASSIGNMENT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Only the separate fault-proof addon exports this thread-local, one-shot fault.
#[cfg(feature = "fault-injection")]
#[napi]
pub fn fail_next_windows_job_assignment() {
    FAIL_ASSIGNMENT.set(true);
}

fn win_error(operation: &str) -> napi::Error {
    let code = unsafe { GetLastError() };
    failure(
        if code == ERROR_ACCESS_DENIED {
            "access-denied"
        } else {
            "operation-failed"
        },
        format!("{operation} failed (Win32 {code})"),
    )
}
fn wide(value: &str) -> Result<Vec<u16>> {
    if value.is_empty() || value.contains('\0') {
        return Err(failure("invalid-argument", "empty string or embedded NUL"));
    }
    Ok(value.encode_utf16().chain(Some(0)).collect())
}

struct Handle(Option<HANDLE>);
impl Handle {
    fn new(raw: HANDLE, operation: &str) -> Result<Self> {
        if raw.is_null() || raw == INVALID_HANDLE_VALUE {
            Err(win_error(operation))
        } else {
            Ok(Self(Some(raw)))
        }
    }
    fn get(&self) -> Result<HANDLE> {
        self.0
            .ok_or_else(|| failure("invalid-argument", "resource is closed"))
    }
    fn close(&mut self) -> Result<()> {
        if let Some(raw) = self.0.take()
            && unsafe { CloseHandle(raw) } == 0
        {
            return Err(win_error("CloseHandle"));
        }
        Ok(())
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn live(handle: HANDLE) -> Result<()> {
    match unsafe { WaitForSingleObject(handle, 0) } {
        WAIT_TIMEOUT => Ok(()),
        WAIT_OBJECT_0 => Err(failure("operation-failed", "pinned process has exited")),
        _ => Err(win_error("WaitForSingleObject")),
    }
}

#[napi]
pub struct NativePinnedProcess {
    handle: Handle,
    pid: u32,
    image: String,
}

#[napi]
pub fn open_pinned_process(
    pid: u32,
    image_path: Option<String>,
    start_time_micros: Option<f64>,
) -> Result<Option<NativePinnedProcess>> {
    if pid == 0 {
        return Err(failure("invalid-argument", "invalid PID"));
    }
    // Acquire all authority once: later operations never reopen this PID.
    let raw = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION
                | PROCESS_DUP_HANDLE
                | PROCESS_SET_QUOTA
                | PROCESS_TERMINATE
                | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if raw.is_null() && unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
        return Ok(None);
    }
    let handle = Handle::new(raw, "OpenProcess")?;
    let identity = read_handle(pid, handle.get()?)?;
    let mut image = vec![0u16; 32768];
    let mut length = image.len() as u32;
    if unsafe { QueryFullProcessImageNameW(handle.get()?, 0, image.as_mut_ptr(), &mut length) } == 0
    {
        return Err(win_error("QueryFullProcessImageNameW"));
    }
    if length == 0 || length as usize >= image.len() {
        return Err(failure("layout-mismatch", "invalid process image length"));
    }
    let image = String::from_utf16(&image[..length as usize])
        .map_err(|_| failure("layout-mismatch", "invalid UTF-16 process image"))?;
    if image_path.is_some_and(|expected| expected != image)
        || start_time_micros.is_some_and(|expected| expected != identity.start_time_micros)
    {
        return Err(failure(
            "operation-failed",
            "pinned process identity does not match expectations",
        ));
    }
    Ok(Some(NativePinnedProcess { handle, pid, image }))
}

#[napi]
impl NativePinnedProcess {
    #[napi(getter)]
    pub fn identity(&self) -> Result<ProcessIdentity> {
        read_handle(self.pid, self.handle.get()?)
    }
    #[napi(getter)]
    pub fn image_path(&self) -> Result<String> {
        self.handle.get()?;
        Ok(self.image.clone())
    }
    #[napi]
    pub fn close(&mut self) -> Result<()> {
        self.handle.close()
    }
    #[napi]
    pub fn bind_lifetime(&self) -> Result<()> {
        let owner = self.handle.get()?;
        live(owner)?;
        let job = create_job(None, true)?;
        let local = job.handle.get()?;
        let mut remote = null_mut();
        if unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                local,
                owner,
                &mut remote,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        } == 0
        {
            return Err(win_error("DuplicateHandle(job to owner)"));
        }
        let assigned = (|| {
            // The duplicate is non-inheritable. Only the pinned owner can keep this job alive.
            live(owner)?;
            #[cfg(feature = "fault-injection")]
            if FAIL_ASSIGNMENT.replace(false) {
                return Err(failure(
                    "operation-failed",
                    "injected job assignment failure",
                ));
            }
            if unsafe { AssignProcessToJobObject(local, GetCurrentProcess()) } == 0 {
                return Err(win_error("AssignProcessToJobObject(lifetime)"));
            }
            Ok(())
        })();
        if let Err(error) = assigned {
            let mut rollback = null_mut();
            if unsafe {
                DuplicateHandle(
                    owner,
                    remote,
                    GetCurrentProcess(),
                    &mut rollback,
                    0,
                    0,
                    DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS,
                )
            } != 0
            {
                Handle::new(rollback, "DuplicateHandle(rollback)")?.close()?;
            } else if unsafe { WaitForSingleObject(owner, 0) } != WAIT_OBJECT_0 {
                // An exited owner already closed all its handles. Any other failure is uncertain.
                return Err(win_error(
                    "DuplicateHandle(close remote job after failed admission)",
                ));
            }
            return Err(error);
        }
        // Owner death now closes its copy; releasing ours immediately enforces kill-on-close.
        let mut job = job;
        job.close()
    }
}

#[napi]
pub struct NativeJob {
    handle: Handle,
}

fn create_job(name: Option<String>, kill: bool) -> Result<NativeJob> {
    let name = name.as_deref().map(wide).transpose()?;
    let raw = unsafe { CreateJobObjectW(null(), name.as_ref().map_or(null(), |s| s.as_ptr())) };
    let handle = Handle::new(raw, "CreateJobObjectW")?;
    // Never modify a pre-existing named job whose limits belong to another owner.
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        return Err(failure("operation-failed", "named job already exists"));
    }
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    if kill {
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    }
    if unsafe {
        SetInformationJobObject(
            handle.get()?,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err(win_error("SetInformationJobObject"));
    }
    Ok(NativeJob { handle })
}

#[napi]
pub fn create_windows_job(name: Option<String>, kill_on_job_close: bool) -> Result<NativeJob> {
    create_job(name, kill_on_job_close)
}

#[napi]
pub fn open_windows_job(name: String) -> Result<Option<NativeJob>> {
    let name = wide(&name)?;
    let raw = unsafe {
        OpenJobObjectW(
            0x0001 | 0x0004 | 0x0008, // assign, query, terminate access
            0,
            name.as_ptr(),
        )
    };
    if raw.is_null() && unsafe { GetLastError() } == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    Ok(Some(NativeJob {
        handle: Handle::new(raw, "OpenJobObjectW")?,
    }))
}

#[napi(object)]
pub struct JobAccounting {
    pub active_processes: u32,
    pub total_processes: u32,
    pub terminated_processes: u32,
}

#[napi]
impl NativeJob {
    #[napi]
    pub fn assign_current(&self) -> Result<()> {
        if unsafe { AssignProcessToJobObject(self.handle.get()?, GetCurrentProcess()) } == 0 {
            return Err(win_error("AssignProcessToJobObject"));
        }
        Ok(())
    }
    #[napi]
    pub fn assign(&self, process: &NativePinnedProcess) -> Result<()> {
        let handle = process.handle.get()?;
        live(handle)?;
        if unsafe { AssignProcessToJobObject(self.handle.get()?, handle) } == 0 {
            return Err(win_error("AssignProcessToJobObject"));
        }
        Ok(())
    }
    #[napi]
    pub fn close(&mut self) -> Result<()> {
        self.handle.close()
    }
    #[napi]
    pub fn retain(&mut self) -> Result<()> {
        self.assign_current()?;
        // Deliberately relinquish Rust/JS ownership. The OS closes this at process exit,
        // including after Worker teardown or a crash; no JS finalizer may kill the caller.
        self.handle.0.take();
        Ok(())
    }
    #[napi]
    pub fn accounting(&self) -> Result<JobAccounting> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        let mut bytes = 0;
        if unsafe {
            QueryInformationJobObject(
                self.handle.get()?,
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                &mut bytes,
            )
        } == 0
        {
            return Err(win_error("QueryInformationJobObject(accounting)"));
        }
        if bytes as usize != size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() {
            return Err(failure("layout-mismatch", "invalid job accounting size"));
        }
        Ok(JobAccounting {
            active_processes: info.ActiveProcesses,
            total_processes: info.TotalProcesses,
            terminated_processes: info.TotalTerminatedProcesses,
        })
    }
    #[napi]
    pub fn process_ids(&self) -> Result<Vec<u32>> {
        // Match the consumer's bounded, single complete observation; never return a prefix.
        const CAPACITY: usize = 4096;
        let mut storage = vec![0usize; CAPACITY + 1];
        let bytes = storage.len() * size_of::<usize>();
        let mut returned = 0;
        if unsafe {
            QueryInformationJobObject(
                self.handle.get()?,
                JobObjectBasicProcessIdList,
                storage.as_mut_ptr().cast(),
                bytes as u32,
                &mut returned,
            )
        } == 0
        {
            return Err(if unsafe { GetLastError() } == ERROR_MORE_DATA {
                failure(
                    "incomplete",
                    "job process list exceeds observation capacity",
                )
            } else {
                win_error("QueryInformationJobObject(process IDs)")
            });
        }
        let header = storage.as_ptr().cast::<u32>();
        let assigned = unsafe { *header } as usize;
        let listed = unsafe { *header.add(1) } as usize;
        if assigned != listed
            || listed > CAPACITY
            || returned as usize > bytes
            || (returned as usize) < 8 + listed * size_of::<usize>()
        {
            return Err(failure("incomplete", "job process list is incomplete"));
        }
        let mut result = Vec::with_capacity(listed);
        for &pid in &storage[1..1 + listed] {
            if pid == 0 || pid > u32::MAX as usize || result.contains(&(pid as u32)) {
                return Err(failure("layout-mismatch", "invalid job process ID"));
            }
            result.push(pid as u32);
        }
        Ok(result)
    }
    #[napi]
    pub fn terminate(&self, exit_code: u32) -> Result<()> {
        if unsafe { TerminateJobObject(self.handle.get()?, exit_code) } == 0 {
            return Err(win_error("TerminateJobObject"));
        }
        Ok(())
    }
    #[napi]
    pub fn spawn(
        &self,
        executable: String,
        command_line: String,
        cwd: Option<String>,
        environment: Option<Vec<String>>,
    ) -> Result<NativeJobChild> {
        let executable = wide(&executable)?;
        let mut command = wide(&command_line)?;
        if command.len() > 32767 {
            return Err(failure(
                "invalid-argument",
                "command line exceeds Windows limit",
            ));
        }
        let cwd = cwd.as_deref().map(wide).transpose()?;
        let environment = environment
            .map(|entries| -> Result<Vec<u16>> {
                let mut block = Vec::new();
                for entry in entries {
                    block.extend(wide(&entry)?);
                }
                block.push(0);
                if block.len() == 1 {
                    block.push(0);
                }
                Ok(block)
            })
            .transpose()?;
        let sa = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };
        let (stdout, stdout_write) = pipe(&sa)?;
        let (stderr, stderr_write) = pipe(&sa)?;
        let nul = wide("NUL")?;
        let stdin = Handle::new(
            unsafe {
                CreateFileW(
                    nul.as_ptr(),
                    FILE_GENERIC_READ,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    &sa,
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    null_mut(),
                )
            },
            "CreateFileW(NUL)",
        )?;
        let mut size = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut size);
        }
        if size == 0 {
            return Err(win_error("InitializeProcThreadAttributeList(size)"));
        }
        let mut attributes = vec![0usize; size.div_ceil(size_of::<usize>())];
        let ptr = attributes.as_mut_ptr().cast::<c_void>();
        if unsafe { InitializeProcThreadAttributeList(ptr, 2, 0, &mut size) } == 0 {
            return Err(win_error("InitializeProcThreadAttributeList"));
        }
        struct Attributes(*mut c_void);
        impl Drop for Attributes {
            fn drop(&mut self) {
                unsafe {
                    DeleteProcThreadAttributeList(self.0);
                }
            }
        }
        let attributes_guard = Attributes(ptr);
        let inherited = [stdin.get()?, stdout_write.get()?, stderr_write.get()?];
        let jobs = [self.handle.get()?];
        for (attribute, values) in [
            (PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited.as_slice()),
            (PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs.as_slice()),
        ] {
            if unsafe {
                UpdateProcThreadAttribute(
                    ptr,
                    0,
                    attribute as usize,
                    values.as_ptr().cast(),
                    std::mem::size_of_val(values),
                    null_mut(),
                    null(),
                )
            } == 0
            {
                return Err(win_error("UpdateProcThreadAttribute"));
            }
        }
        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdin.get()?;
        startup.StartupInfo.hStdOutput = stdout_write.get()?;
        startup.StartupInfo.hStdError = stderr_write.get()?;
        startup.lpAttributeList = ptr;
        let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
        let created = unsafe {
            CreateProcessW(
                executable.as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_NEW_PROCESS_GROUP
                    | CREATE_UNICODE_ENVIRONMENT
                    | EXTENDED_STARTUPINFO_PRESENT
                    | CREATE_NO_WINDOW,
                environment.as_ref().map_or(null(), |e| e.as_ptr().cast()),
                cwd.as_ref().map_or(null(), |c| c.as_ptr()),
                &startup.StartupInfo,
                &mut info,
            )
        };
        // Read the error before destructors can replace the thread's last-error value.
        if created == 0 {
            return Err(win_error("CreateProcessW(JOB_LIST)"));
        }
        let process = Handle::new(info.hProcess, "CreateProcessW(process)")?;
        let mut thread = Handle::new(info.hThread, "CreateProcessW(thread)")?;
        if let Err(error) = thread.close() {
            unsafe {
                TerminateProcess(process.get()?, 1);
            }
            return Err(error);
        }
        drop(attributes_guard);
        Ok(NativeJobChild {
            process,
            pid: info.dwProcessId,
            stdout: Pipe {
                handle: stdout,
                ended: false,
            },
            stderr: Pipe {
                handle: stderr,
                ended: false,
            },
        })
    }
}

fn pipe(sa: &SECURITY_ATTRIBUTES) -> Result<(Handle, Handle)> {
    let mut read = null_mut();
    let mut write = null_mut();
    if unsafe { CreatePipe(&mut read, &mut write, sa, 0) } == 0 {
        return Err(win_error("CreatePipe"));
    }
    let read = Handle::new(read, "CreatePipe(read)")?;
    let write = Handle::new(write, "CreatePipe(write)")?;
    if unsafe { SetHandleInformation(read.get()?, HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(win_error("SetHandleInformation"));
    }
    Ok((read, write))
}

struct Pipe {
    handle: Handle,
    ended: bool,
}
impl Pipe {
    fn read(&mut self, max_bytes: u32) -> Result<Option<Buffer>> {
        if max_bytes == 0 {
            return Err(failure("invalid-argument", "maxBytes must be positive"));
        }
        if self.ended {
            return Ok(None);
        }
        let handle = self.handle.get()?;
        let mut available = 0;
        if unsafe {
            PeekNamedPipe(
                handle,
                null_mut(),
                0,
                null_mut(),
                &mut available,
                null_mut(),
            )
        } == 0
        {
            if unsafe { GetLastError() } == ERROR_BROKEN_PIPE {
                self.ended = true;
                self.handle.close()?;
                return Ok(None);
            }
            return Err(win_error("PeekNamedPipe"));
        }
        let count = available.min(max_bytes);
        let mut output = Vec::new();
        output
            .try_reserve_exact(count as usize)
            .map_err(|_| failure("operation-failed", "cannot allocate output buffer"))?;
        output.resize(count as usize, 0);
        if count == 0 {
            return Ok(Some(output.into()));
        }
        let mut read = 0;
        // This owner has the only read handle; no other reader can consume peeked bytes.
        if unsafe { ReadFile(handle, output.as_mut_ptr(), count, &mut read, null_mut()) } == 0 {
            return Err(win_error("ReadFile"));
        }
        if read == 0 || read > count {
            return Err(failure(
                "incomplete",
                "pipe read did not return available bytes",
            ));
        }
        output.truncate(read as usize);
        Ok(Some(output.into()))
    }
}

#[napi]
pub struct NativeJobChild {
    process: Handle,
    pid: u32,
    stdout: Pipe,
    stderr: Pipe,
}
#[napi]
impl NativeJobChild {
    #[napi(getter)]
    pub fn pid(&self) -> Result<u32> {
        self.process.get()?;
        Ok(self.pid)
    }
    #[napi]
    pub fn read_stdout(&mut self, max_bytes: u32) -> Result<Option<Buffer>> {
        self.process.get()?;
        self.stdout.read(max_bytes)
    }
    #[napi]
    pub fn read_stderr(&mut self, max_bytes: u32) -> Result<Option<Buffer>> {
        self.process.get()?;
        self.stderr.read(max_bytes)
    }
    #[napi]
    pub fn exit_code(&self) -> Result<Option<u32>> {
        let handle = self.process.get()?;
        match unsafe { WaitForSingleObject(handle, 0) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0;
                if unsafe { GetExitCodeProcess(handle, &mut code) } == 0 {
                    return Err(win_error("GetExitCodeProcess"));
                }
                Ok(Some(code))
            }
            _ => Err(win_error("WaitForSingleObject")),
        }
    }
    #[napi]
    pub fn close(&mut self) -> Result<()> {
        let stdout = self.stdout.handle.close();
        let stderr = self.stderr.handle.close();
        let process = self.process.close();
        stdout.and(stderr).and(process)
    }
}

#[napi]
pub fn is_current_process_in_job() -> Result<bool> {
    let mut inside = 0;
    if unsafe { IsProcessInJob(GetCurrentProcess(), null_mut(), &mut inside) } == 0 {
        return Err(win_error("IsProcessInJob"));
    }
    Ok(inside != 0)
}
